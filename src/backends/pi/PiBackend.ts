import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type {
  BackendLaunchArgs,
  BackendProcess,
  BackendState,
  PromptInput,
  SessionEvent,
  SessionEventListener,
  UiRequest,
  UiResponse,
  Unsubscribe,
} from "../../session/types";
import { JsonlSplitter } from "./jsonl";
import { parsePiWireEvent, type PiWireEvent } from "./wire";

const INIT_REQUEST_ID = "ys-init";
const KILL_GRACE_MS = 1500;

interface PiBackendOptions extends BackendLaunchArgs {
  readonly executablePath: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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
  private currentState: BackendState = "starting";
  private stderrTail = "";
  private disposing = false;
  private exitPromise: Promise<void>;

  constructor(options: PiBackendOptions) {
    this.child = spawn(options.executablePath, ["--mode", "rpc"], {
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
        resolve();
      });
    });

    this.child.once("error", (error: Error) => {
      this.setState("error", `Failed to start pi: ${error.message}`);
    });

    // Handshake: a successful get_state response proves the RPC protocol
    // is live, flipping state from "starting" to "ready".
    this.writeCommand({ type: "get_state", id: INIT_REQUEST_ID });
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

  async abort(): Promise<void> {
    this.assertWritable();
    this.writeCommand({ type: "abort" });
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
      case "response":
        if (event.id === INIT_REQUEST_ID && event.success && this.currentState === "starting") {
          this.setState("ready");
          return;
        }
        if (!event.success && event.error !== undefined) {
          this.emit({ kind: "error", message: `${event.command}: ${event.error}` });
        }
        return;
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
