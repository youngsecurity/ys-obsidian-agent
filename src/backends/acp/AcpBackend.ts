import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type {
  BackendLaunchArgs,
  BackendProcess,
  BackendState,
  ModelInfo,
  PromptInput,
  SessionEvent,
  SessionEventListener,
  UiResponse,
  Unsubscribe,
} from "../../session/types";
import {
  type AcpSessionConfig,
  AcpUpdateTranslator,
  applyConfigOptionUpdate,
  currentModel,
  isRecord,
  parseSessionConfig,
  type PermissionChoice,
  translatePermission,
} from "./translate";

const KILL_GRACE_MS = 1500;
/** Unstable ACP method used by adapters that expose the older `models` field. */
const SET_MODEL_METHOD = "session/set_model";

export interface AcpBackendOptions extends BackendLaunchArgs {
  readonly executablePath: string;
  /** Backend id; labels models as `<backendId>/<modelId>` in settings. */
  readonly backendId: string;
  /** Extra CLI args for the adapter (tests, settings). */
  readonly extraArgs?: readonly string[];
}

interface PendingPermission {
  readonly choices: readonly PermissionChoice[];
  readonly resolve: (response: acp.RequestPermissionResponse) => void;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error["message"] === "string") return error["message"];
  return String(error);
}

/**
 * ACP backend (phase 2, docs/design.md): spawns an ACP-speaking agent
 * adapter (Claude Code, Codex) and translates JSON-RPC session updates
 * into session-domain events at this boundary.
 *
 * Contract mapping that differs from pi:
 * - `steer`/`followUp` queue text and send it as the next prompt when the
 *   current turn ends (ACP has no mid-turn steering). `abort` clears the
 *   queue, matching the interactive Esc convention.
 * - `resumeHandle` is the ACP session id; resume uses `session/load`, which
 *   replays history through the same update stream.
 * - Model and thinking choices come from `configOptions` (Codex) or the
 *   older `models` field (Claude Code); see `parseSessionConfig`.
 * - Permission requests become `select` dialogs; dismissing answers
 *   `cancelled`, as the spec requires after a cancel.
 */
export class AcpBackendProcess implements BackendProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: acp.ClientConnection;
  private readonly listeners = new Set<SessionEventListener>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly queue: string[] = [];
  private readonly backendId: string;
  private readonly vaultRootAbs: string;
  private translator = new AcpUpdateTranslator();
  private config: AcpSessionConfig;
  private sessionId: string | undefined;
  private canLoadSession = false;
  private currentState: BackendState = "starting";
  private stderrTail = "";
  private disposing = false;
  private nextPermissionId = 1;
  private readonly exitPromise: Promise<void>;

  constructor(options: AcpBackendOptions) {
    this.backendId = options.backendId;
    this.vaultRootAbs = options.vaultRootAbs;
    this.config = parseSessionConfig(undefined, options.backendId);

    this.child = spawn(options.executablePath, [...(options.extraArgs ?? [])], {
      cwd: options.vaultRootAbs,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        const detail = `${options.backendId} exited (code ${String(code)}, signal ${String(signal)})`;
        if (this.disposing) {
          this.setState("exited", detail);
        } else {
          const stderr = this.stderrTail.trim();
          this.setState("error", stderr.length > 0 ? `${detail}: ${stderr}` : detail);
        }
        this.cancelPendingPermissions();
        resolve();
      });
    });
    this.child.once("error", (error: Error) => {
      this.setState("error", `Failed to start ${options.backendId}: ${error.message}`);
    });

    // Node's web-stream typings and the DOM lib's differ in generics only;
    // at runtime they are the same WHATWG streams the SDK expects.
    const stream = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>
    );
    this.connection = acp
      .client({ name: "ys-obsidian-agent" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.handlePermission(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.handleUpdate(ctx.params);
      })
      .connect(stream);

    void this.start(options);
  }

  get state(): BackendState {
    return this.currentState;
  }

  subscribe(listener: SessionEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async start(options: AcpBackendOptions): Promise<void> {
    try {
      const init = await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      this.canLoadSession = init.agentCapabilities?.loadSession === true;
      const authHint = (init.authMethods ?? [])
        .map((method) => method.description ?? method.name)
        .filter((text) => text.length > 0)
        .join("; ");

      try {
        await this.openSession(options.resumeHandle);
      } catch (error) {
        const message = errorText(error);
        this.setState(
          "error",
          authHint.length > 0 ? `${message}. To authenticate: ${authHint}` : message
        );
        return;
      }
      await this.applyDefaults(options.model, options.thinkingLevel);
      this.emitSessionInfo();
      if (this.currentState === "starting") this.setState("ready");
    } catch (error) {
      if (this.currentState === "starting") this.setState("error", errorText(error));
    }
  }

  /** `session/load` when resuming and supported, otherwise `session/new`. */
  private async openSession(resumeHandle: string | undefined): Promise<void> {
    this.translator = new AcpUpdateTranslator();
    if (resumeHandle !== undefined && this.canLoadSession) {
      try {
        this.sessionId = resumeHandle;
        const loaded = await this.connection.agent.request(acp.methods.agent.session.load, {
          sessionId: resumeHandle,
          cwd: this.vaultRootAbs,
          mcpServers: [],
        });
        for (const event of this.translator.endTurn()) this.emit(event);
        this.config = parseSessionConfig(loaded, this.backendId);
        return;
      } catch {
        // Unknown or stale session id: fall through to a fresh session.
        this.sessionId = undefined;
        this.translator = new AcpUpdateTranslator();
        this.emit({ kind: "session_reset" });
      }
    }
    const created = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: this.vaultRootAbs,
      mcpServers: [],
    });
    this.sessionId = created.sessionId;
    this.config = parseSessionConfig(created, this.backendId);
  }

  /** Apply settings defaults when they differ from what the agent chose. */
  private async applyDefaults(model: string | undefined, thinkingLevel: string | undefined): Promise<void> {
    const wantedModelId = model === undefined || model.length === 0 ? undefined : model.split("/").pop();
    if (wantedModelId !== undefined && wantedModelId !== this.config.currentModelId) {
      const target = this.config.models.find((entry) => entry.id === wantedModelId);
      if (target !== undefined) {
        try {
          await this.setModel(target);
        } catch (error) {
          this.emit({ kind: "error", message: `Default model not applied: ${errorText(error)}` });
        }
      } else if (this.config.models.length > 0) {
        this.emit({ kind: "error", message: `Default model "${wantedModelId}" is not offered by ${this.backendId}.` });
      }
    }
    if (thinkingLevel !== undefined && thinkingLevel.length > 0 && thinkingLevel !== this.config.currentThinkingLevel) {
      if (this.config.thinkingLevels.includes(thinkingLevel)) {
        try {
          await this.setThinkingLevel(thinkingLevel);
        } catch (error) {
          this.emit({ kind: "error", message: `Default thinking level not applied: ${errorText(error)}` });
        }
      } else if (this.config.thinkingConfigId !== undefined) {
        this.emit({
          kind: "error",
          message: `Default thinking level "${thinkingLevel}" is not offered by ${this.backendId} (available: ${this.config.thinkingLevels.join(", ")}).`,
        });
      }
    }
  }

  async prompt(input: PromptInput): Promise<void> {
    this.assertWritable();
    if (this.currentState === "streaming") {
      this.enqueue(input.message);
      return;
    }
    await this.runPrompt(input);
  }

  private async runPrompt(input: PromptInput): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === undefined) throw new Error("No ACP session is open");
    const prompt: acp.ContentBlock[] = [{ type: "text", text: input.message }];
    for (const image of input.images ?? []) {
      prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    this.setState("streaming");
    try {
      await this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt });
    } catch (error) {
      this.emit({ kind: "error", message: errorText(error) });
    } finally {
      for (const event of this.translator.endTurn()) this.emit(event);
    }
    if (this.currentState !== "streaming") return;
    const next = this.queue.shift();
    if (next !== undefined) {
      this.emitQueue();
      void this.runPrompt({ message: next });
      return;
    }
    this.setState("ready");
  }

  async steer(message: string): Promise<void> {
    this.assertWritable();
    if (this.currentState !== "streaming") {
      await this.runPrompt({ message });
      return;
    }
    this.enqueue(message);
  }

  async followUp(message: string): Promise<void> {
    await this.steer(message);
  }

  private enqueue(message: string): void {
    this.queue.push(message);
    this.emitQueue();
  }

  private emitQueue(): void {
    this.emit({ kind: "queue_update", steering: [], followUp: [...this.queue] });
  }

  async abort(): Promise<void> {
    this.assertWritable();
    if (this.queue.length > 0) {
      this.queue.length = 0;
      this.emitQueue();
    }
    this.cancelPendingPermissions();
    const sessionId = this.sessionId;
    if (sessionId === undefined || this.currentState !== "streaming") return;
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async newSession(): Promise<void> {
    this.assertWritable();
    if (this.currentState === "streaming") throw new Error("Stop the agent before starting a new session");
    this.queue.length = 0;
    await this.openSession(undefined);
    this.emit({ kind: "session_reset" });
    this.emitSessionInfo();
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.config.models;
  }

  async setModel(model: ModelInfo): Promise<void> {
    this.assertWritable();
    const sessionId = this.sessionId;
    if (sessionId === undefined) throw new Error("No ACP session is open");
    switch (this.config.modelMechanism) {
      case "config_option": {
        const configId = this.config.modelConfigId;
        if (configId === undefined) throw new Error("Model option id missing");
        const response = await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId,
          value: model.id,
        });
        this.config = applyConfigOptionUpdate(this.config, response, this.backendId);
        break;
      }
      case "set_model":
        await this.connection.agent.request(SET_MODEL_METHOD, { sessionId, modelId: model.id });
        this.config = { ...this.config, currentModelId: model.id };
        break;
      case "none":
        throw new Error(`${this.backendId} does not expose model selection`);
      default: {
        const _exhaustive: never = this.config.modelMechanism;
        void _exhaustive;
      }
    }
    this.emitSessionInfo();
  }

  async listThinkingLevels(): Promise<readonly string[]> {
    return this.config.thinkingLevels;
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.assertWritable();
    const sessionId = this.sessionId;
    const configId = this.config.thinkingConfigId;
    if (sessionId === undefined) throw new Error("No ACP session is open");
    if (configId === undefined) throw new Error(`${this.backendId} does not expose a thinking level`);
    const response = await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value: level,
    });
    this.config = applyConfigOptionUpdate(this.config, response, this.backendId);
    this.emitSessionInfo();
  }

  respondUi(response: UiResponse): void {
    const pending = this.pendingPermissions.get(response.id);
    if (pending === undefined) return;
    this.pendingPermissions.delete(response.id);
    if (response.kind === "value") {
      const choice = pending.choices.find((entry) => entry.name === response.value);
      if (choice !== undefined) {
        pending.resolve({ outcome: { outcome: "selected", optionId: choice.optionId } });
        return;
      }
    }
    pending.resolve({ outcome: { outcome: "cancelled" } });
  }

  async dispose(): Promise<void> {
    if (this.disposing) {
      await this.exitPromise;
      return;
    }
    this.disposing = true;
    this.cancelPendingPermissions();
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.setState("exited");
      return;
    }
    try {
      this.connection.close();
    } catch {
      // Already closed.
    }
    this.signalTree("SIGTERM");
    const graceful = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS)),
    ]);
    if (!graceful) {
      this.signalTree("SIGKILL");
      await this.exitPromise;
    }
  }

  private handlePermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const id = `perm-${String(this.nextPermissionId++)}`;
    const translated = translatePermission(id, params);
    if (translated === null) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, { choices: translated.choices, resolve });
      this.emit({ kind: "ui_request", request: translated.request });
    });
  }

  private cancelPendingPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }

  private handleUpdate(params: acp.SessionNotification): void {
    if (this.sessionId !== undefined && params.sessionId !== this.sessionId) return;
    const update: unknown = params.update;
    if (isRecord(update) && update["sessionUpdate"] === "config_option_update") {
      this.config = applyConfigOptionUpdate(this.config, update, this.backendId);
      this.emitSessionInfo();
      return;
    }
    for (const event of this.translator.update(update)) this.emit(event);
  }

  private emitSessionInfo(): void {
    this.emit({
      kind: "session_info",
      resumeHandle: this.sessionId,
      model: currentModel(this.config),
      thinkingLevel: this.config.currentThinkingLevel,
    });
  }

  private signalTree(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Process group already gone or not a leader; fall through.
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      // Already exited.
    }
  }

  private assertWritable(): void {
    if (this.currentState === "exited" || this.currentState === "error") {
      throw new Error(`${this.backendId} backend is not running (state: ${this.currentState})`);
    }
  }

  private setState(state: BackendState, detail?: string): void {
    if (this.currentState === state && detail === undefined) return;
    if (this.currentState === "exited") return;
    this.currentState = state;
    this.emit(detail === undefined ? { kind: "state_change", state } : { kind: "state_change", state, detail });
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
