import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type {
  BackendLaunchArgs,
  BackendProcess,
  BackendState,
  ModelInfo,
  PromptInput,
  SessionEvent,
  SessionEventListener,
  UiRequest,
  UiResponse,
  Unsubscribe,
} from "../../session/types";
import { translateHistory } from "./history";
import { JsonlSplitter } from "./jsonl";
import {
  asString,
  isRecord,
  parseModel,
  parsePiWireEvent,
  parseSessionState,
  type PiWireEvent,
  stringArray,
} from "./wire";

const KILL_GRACE_MS = 1500;

export interface PiBackendOptions extends BackendLaunchArgs {
  readonly executablePath: string;
  /** Additional pi CLI flags appended after `--mode rpc` (tests, settings). */
  readonly extraArgs?: readonly string[];
}

type PiResponse = Extract<PiWireEvent, { type: "response" }>;

/**
 * Translate a raw `extension_ui_request` record into the session-domain
 * {@link UiRequest}. Fire-and-forget presentation methods this plugin does
 * not surface (setStatus, setWidget, setTitle, set_editor_text) map to
 * `null` and are ignored; they expect no response.
 */
function translateUiRequest(raw: Record<string, unknown>): UiRequest | null {
  const id = asString(raw["id"]);
  const method = asString(raw["method"]);
  if (id === undefined || method === undefined) return null;
  switch (method) {
    case "select": {
      const options = Array.isArray(raw["options"])
        ? raw["options"].filter((option): option is string => typeof option === "string")
        : [];
      return { kind: "select", id, title: asString(raw["title"]) ?? "Select", options };
    }
    case "confirm":
      return {
        kind: "confirm",
        id,
        title: asString(raw["title"]) ?? "Confirm",
        message: asString(raw["message"]),
      };
    case "input":
      return {
        kind: "input",
        id,
        title: asString(raw["title"]) ?? "Input",
        placeholder: asString(raw["placeholder"]),
      };
    case "editor":
      return {
        kind: "editor",
        id,
        title: asString(raw["title"]) ?? "Edit",
        prefill: asString(raw["prefill"]),
      };
    case "notify": {
      const message = asString(raw["message"]);
      if (message === undefined) return null;
      const notifyType = asString(raw["notifyType"]);
      const level =
        notifyType === "warning" || notifyType === "error" ? notifyType : ("info" as const);
      return { kind: "notify", id, message, level };
    }
    default:
      return null;
  }
}

/**
 * Spawns `pi --mode rpc` in the vault root and translates the pi wire
 * protocol into session-domain events at this boundary (docs/design.md).
 */
export class PiBackendProcess implements BackendProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<SessionEventListener>();
  private readonly stdoutSplitter = new JsonlSplitter();
  private readonly pending = new Map<string, (response: PiResponse) => void>();
  private nextRequestId = 1;
  private currentState: BackendState = "starting";
  private stderrTail = "";
  private disposing = false;
  private exitPromise: Promise<void>;

  constructor(options: PiBackendOptions) {
    const args = ["--mode", "rpc", ...(options.extraArgs ?? [])];
    if (options.resumeHandle !== undefined) args.push("--session", options.resumeHandle);
    if (options.model !== undefined && options.model.length > 0) args.push("--model", options.model);
    if (options.thinkingLevel !== undefined && options.thinkingLevel.length > 0) {
      args.push("--thinking", options.thinkingLevel);
    }
    this.child = spawn(options.executablePath, args, {
      cwd: options.vaultRootAbs,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutDecoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const line of this.stdoutSplitter.push(stdoutDecoder.write(chunk))) {
        this.handleRecord(line);
      }
    });
    this.child.stdout.on("end", () => {
      for (const line of this.stdoutSplitter.end()) this.handleRecord(line);
    });

    const stderrDecoder = new StringDecoder("utf8");
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + stderrDecoder.write(chunk)).slice(-4000);
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        const expected = this.disposing;
        const detail = `pi exited (code ${String(code)}, signal ${String(signal)})`;
        if (expected) {
          this.setState("exited", detail);
        } else {
          const stderr = this.stderrTail.trim();
          this.setState("error", stderr.length > 0 ? `${detail}: ${stderr}` : detail);
        }
        this.failPending(detail);
        resolve();
      });
    });

    this.child.once("error", (error: Error) => {
      this.setState("error", `Failed to start pi: ${error.message}`);
      this.failPending(error.message);
    });

    void this.start(options.resumeHandle !== undefined);
  }

  /**
   * Handshake: a successful get_state response proves the RPC protocol is
   * live and reveals the session file (resume handle). When resuming,
   * replay stored history before reporting "ready" so the transcript is
   * complete before the first prompt.
   */
  private async start(resuming: boolean): Promise<void> {
    try {
      const state = await this.request({ type: "get_state" });
      if (!state.success) {
        // An exit or spawn failure already reported its own error detail.
        if (this.currentState === "starting") {
          this.setState("error", `pi handshake failed: ${state.error ?? "unknown error"}`);
        }
        return;
      }
      this.emitSessionInfo(state.data);
      if (resuming) await this.replayHistory();
      if (this.currentState === "starting") this.setState("ready");
    } catch (error) {
      // Exit and spawn failures already moved state to "error".
      void error;
    }
  }

  private async replayHistory(): Promise<void> {
    const response = await this.request({ type: "get_messages" });
    if (!response.success) {
      this.emit({ kind: "error", message: `Could not load session history: ${response.error ?? "unknown error"}` });
      return;
    }
    const messages = isRecord(response.data) ? response.data["messages"] : undefined;
    for (const event of translateHistory(messages)) this.emit(event);
  }

  get state(): BackendState {
    return this.currentState;
  }

  subscribe(listener: SessionEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(input: PromptInput): Promise<void> {
    this.assertWritable();
    const images = input.images?.map((image) => ({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    }));
    this.writeCommand(
      images === undefined
        ? { type: "prompt", message: input.message }
        : { type: "prompt", message: input.message, images }
    );
  }

  async steer(message: string): Promise<void> {
    this.assertWritable();
    this.writeCommand({ type: "steer", message });
  }

  async followUp(message: string): Promise<void> {
    this.assertWritable();
    this.writeCommand({ type: "follow_up", message });
  }

  /**
   * Interactive-stop semantics (pi docs: send `clear_queue` before `abort`):
   * queued steer/follow-up text is dropped so a stop does not immediately
   * kick off the next queued prompt. Matches the ACP backend.
   */
  async abort(): Promise<void> {
    this.assertWritable();
    this.writeCommand({ type: "clear_queue" });
    this.writeCommand({ type: "abort" });
  }

  /**
   * Start a fresh pi session. Pi's `new_session` response does not carry
   * the new session file, so a follow-up `get_state` refreshes the handle.
   */
  async newSession(): Promise<void> {
    this.assertWritable();
    const response = await this.request({ type: "new_session" });
    if (!response.success) {
      throw new Error(response.error ?? "pi refused to start a new session");
    }
    if (isRecord(response.data) && response.data["cancelled"] === true) {
      throw new Error("An extension cancelled the new session");
    }
    this.emit({ kind: "session_reset" });
    await this.refreshSessionInfo();
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    this.assertWritable();
    const response = await this.request({ type: "get_available_models" });
    if (!response.success) throw new Error(response.error ?? "Could not list models");
    const raw = isRecord(response.data) ? response.data["models"] : undefined;
    if (!Array.isArray(raw)) return [];
    return raw.map(parseModel).filter((model): model is ModelInfo => model !== undefined);
  }

  /**
   * Pi has no model-changed event and answers `get_state` out of order
   * while a slow `set_model` is in flight, so refresh only after it resolves.
   */
  async setModel(model: ModelInfo): Promise<void> {
    this.assertWritable();
    const response = await this.request({
      type: "set_model",
      provider: model.provider,
      modelId: model.id,
    });
    if (!response.success) throw new Error(response.error ?? "Could not switch model");
    await this.refreshSessionInfo();
  }

  async listThinkingLevels(): Promise<readonly string[]> {
    this.assertWritable();
    const response = await this.request({ type: "get_available_thinking_levels" });
    if (!response.success) throw new Error(response.error ?? "Could not list thinking levels");
    return stringArray(isRecord(response.data) ? response.data["levels"] : undefined);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.assertWritable();
    const response = await this.request({ type: "set_thinking_level", level });
    if (!response.success) throw new Error(response.error ?? "Could not set thinking level");
    await this.refreshSessionInfo();
  }

  private async refreshSessionInfo(): Promise<void> {
    const state = await this.request({ type: "get_state" });
    this.emitSessionInfo(state.success ? state.data : undefined);
  }

  private emitSessionInfo(stateData: unknown): void {
    const state = parseSessionState(stateData);
    this.emit({
      kind: "session_info",
      resumeHandle: state.sessionFile,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
    });
  }

  respondUi(response: UiResponse): void {
    if (this.currentState === "exited" || this.currentState === "error") return;
    switch (response.kind) {
      case "value":
        this.writeCommand({
          type: "extension_ui_response",
          id: response.id,
          value: response.value,
        });
        return;
      case "confirmed":
        this.writeCommand({
          type: "extension_ui_response",
          id: response.id,
          confirmed: response.confirmed,
        });
        return;
      case "cancelled":
        this.writeCommand({ type: "extension_ui_response", id: response.id, cancelled: true });
        return;
      default: {
        const _exhaustive: never = response;
        void _exhaustive;
      }
    }
  }

  /**
   * Kill the subprocess tree (design doc gotcha 6). On POSIX the child is
   * its own process group leader (detached), so signalling the negative pid
   * reaches grandchildren such as tool subprocesses. Escalates to SIGKILL
   * after a grace period. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.disposing) {
      await this.exitPromise;
      return;
    }
    this.disposing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.setState("exited");
      return;
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
      throw new Error(`pi backend is not running (state: ${this.currentState})`);
    }
  }

  private writeCommand(command: Record<string, unknown>): void {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Send a command with a correlation id and resolve with its response. */
  private request(command: Record<string, unknown>): Promise<PiResponse> {
    const id = `ys-${String(this.nextRequestId++)}`;
    return new Promise<PiResponse>((resolve, reject) => {
      if (!this.child.stdin.writable) {
        reject(new Error("pi stdin is not writable"));
        return;
      }
      this.pending.set(id, resolve);
      this.writeCommand({ ...command, id });
    });
  }

  private failPending(reason: string): void {
    for (const [id, resolve] of this.pending) {
      resolve({ type: "response", id, command: "unknown", success: false, error: reason, data: undefined });
    }
    this.pending.clear();
  }

  private handleRecord(line: string): void {
    const event = parsePiWireEvent(line);
    if (event === null) return;
    this.handleWireEvent(event);
  }

  private handleWireEvent(event: PiWireEvent): void {
    switch (event.type) {
      case "agent_start":
        this.setState("streaming");
        return;
      case "agent_settled":
        this.setState("ready");
        return;
      case "assistant_message_start":
        this.emit({ kind: "assistant_message_start" });
        return;
      case "assistant_message_end":
        this.emit({ kind: "assistant_message_end" });
        return;
      case "text_delta":
        this.emit({ kind: "text_delta", delta: event.delta });
        return;
      case "thinking_delta":
        this.emit({ kind: "thinking_delta", delta: event.delta });
        return;
      case "tool_execution_start":
        this.emit({
          kind: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        return;
      case "tool_execution_update":
        this.emit({ kind: "tool_update", toolCallId: event.toolCallId, output: event.text });
        return;
      case "tool_execution_end":
        this.emit({
          kind: "tool_end",
          toolCallId: event.toolCallId,
          output: event.text,
          isError: event.isError,
        });
        return;
      case "queue_update":
        this.emit({ kind: "queue_update", steering: event.steering, followUp: event.followUp });
        return;
      case "response": {
        const resolve = event.id === undefined ? undefined : this.pending.get(event.id);
        if (resolve !== undefined && event.id !== undefined) {
          this.pending.delete(event.id);
          resolve(event);
          return;
        }
        if (!event.success && event.error !== undefined) {
          this.emit({ kind: "error", message: `${event.command}: ${event.error}` });
        }
        return;
      }
      case "extension_ui_request": {
        const request = translateUiRequest(event.raw);
        if (request !== null) this.emit({ kind: "ui_request", request });
        return;
      }
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
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
