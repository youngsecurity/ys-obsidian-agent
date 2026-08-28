import type {
  BackendProcess,
  BackendState,
  PromptInput,
  SessionEvent,
  UiRequest,
  UiResponse,
  Unsubscribe,
} from "./types";

/** One rendered cell in the transcript. */
export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly text: string;
      readonly thinking: string;
      readonly complete: boolean;
    }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: string;
      readonly done: boolean;
      readonly isError: boolean;
    }
  | { readonly kind: "error"; readonly message: string };

export type SessionChangeListener = () => void;
export type UiRequestListener = (request: UiRequest) => void;

/**
 * Backend-agnostic session state machine. Consumes {@link SessionEvent}s from
 * a {@link BackendProcess} and maintains the transcript the UI renders.
 * Dialog requests are forwarded to a dedicated listener so the UI can present
 * modals without polling.
 */
export class AgentSession {
  private readonly backend: BackendProcess;
  private readonly unsubscribeBackend: Unsubscribe;
  private readonly changeListeners = new Set<SessionChangeListener>();
  private readonly uiRequestListeners = new Set<UiRequestListener>();
  private items: TranscriptItem[] = [];
  private stateDetail: string | undefined;

  constructor(backend: BackendProcess) {
    this.backend = backend;
    this.unsubscribeBackend = backend.subscribe((event) => {
      this.apply(event);
    });
  }

  get state(): BackendState {
    return this.backend.state;
  }

  get detail(): string | undefined {
    return this.stateDetail;
  }

  get transcript(): readonly TranscriptItem[] {
    return this.items;
  }

  onChange(listener: SessionChangeListener): Unsubscribe {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onUiRequest(listener: UiRequestListener): Unsubscribe {
    this.uiRequestListeners.add(listener);
    return () => this.uiRequestListeners.delete(listener);
  }

  /**
   * Send user text. Routed as a prompt when idle and as a steering message
   * while the backend is streaming, so the composer always works.
   */
  async send(input: PromptInput): Promise<void> {
    this.items.push({ kind: "user", text: input.message });
    this.notifyChange();
    if (this.backend.state === "streaming") {
      await this.backend.steer(input.message);
      return;
    }
    await this.backend.prompt(input);
  }

  async abort(): Promise<void> {
    await this.backend.abort();
  }

  respondUi(response: UiResponse): void {
    this.backend.respondUi(response);
  }

  async dispose(): Promise<void> {
    this.unsubscribeBackend();
    await this.backend.dispose();
  }

  private apply(event: SessionEvent): void {
    switch (event.kind) {
      case "state_change":
        this.stateDetail = event.detail;
        break;
      case "assistant_message_start":
        this.items.push({ kind: "assistant", text: "", thinking: "", complete: false });
        break;
      case "text_delta": {
        const cell = this.openAssistantCell();
        this.replaceLast({ ...cell, text: cell.text + event.delta });
        break;
      }
      case "thinking_delta": {
        const cell = this.openAssistantCell();
        this.replaceLast({ ...cell, thinking: cell.thinking + event.delta });
        break;
      }
      case "assistant_message_end": {
        const last = this.items[this.items.length - 1];
        if (last !== undefined && last.kind === "assistant") {
          this.replaceLast({ ...last, complete: true });
        }
        break;
      }
      case "tool_start":
        this.items.push({
          kind: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: "",
          done: false,
          isError: false,
        });
        break;
      case "tool_update":
        this.updateTool(event.toolCallId, (tool) => ({ ...tool, output: event.output }));
        break;
      case "tool_end":
        this.updateTool(event.toolCallId, (tool) => ({
          ...tool,
          output: event.output,
          done: true,
          isError: event.isError,
        }));
        break;
      case "error":
        this.items.push({ kind: "error", message: event.message });
        break;
      case "ui_request":
        for (const listener of this.uiRequestListeners) listener(event.request);
        return;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
    this.notifyChange();
  }

  /** Last transcript cell as an open assistant cell, creating one if needed. */
  private openAssistantCell(): Extract<TranscriptItem, { kind: "assistant" }> {
    const last = this.items[this.items.length - 1];
    if (last !== undefined && last.kind === "assistant" && !last.complete) {
      return last;
    }
    const cell = { kind: "assistant", text: "", thinking: "", complete: false } as const;
    this.items.push(cell);
    return cell;
  }

  private replaceLast(item: TranscriptItem): void {
    this.items[this.items.length - 1] = item;
  }

  private updateTool(
    toolCallId: string,
    update: (
      tool: Extract<TranscriptItem, { kind: "tool" }>
    ) => Extract<TranscriptItem, { kind: "tool" }>
  ): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item !== undefined && item.kind === "tool" && item.toolCallId === toolCallId) {
        this.items[i] = update(item);
        return;
      }
    }
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}
