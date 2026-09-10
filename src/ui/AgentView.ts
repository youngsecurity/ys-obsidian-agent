import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";

import type { AgentSession } from "../session/AgentSession";
import type { Unsubscribe } from "../session/types";
import { TranscriptRenderer } from "./transcriptRenderer";
import { presentUiRequest } from "./uiRequestModals";

export const AGENT_VIEW_TYPE = "ys-agent-chat";

export interface AgentViewHost {
  /** Create or return the live session. Throws when the backend cannot start. */
  acquireSession(): AgentSession;
  /** Dispose the session (kills the subprocess tree, design doc gotcha 6). */
  releaseSession(): Promise<void>;
}

const IDLE_PLACEHOLDER = "Prompt the agent (Enter to send, Shift+Enter for newline)";
const STREAMING_PLACEHOLDER = "Steer the agent (Enter to queue, Esc to stop)";

/**
 * Chat pane. Reads session-domain types only (docs/design.md layering).
 *
 * Milestone 3: the transcript renders tool calls, thinking blocks, and
 * Markdown through an incremental renderer; the composer steers while the
 * agent streams; Stop/Esc interrupt; New session resets. Resume across pane
 * reopen is the host's job: it persists the session's resume handle and
 * relaunches the backend with it.
 */
export class AgentView extends ItemView {
  private session: AgentSession | undefined;
  private readonly subscriptions: Unsubscribe[] = [];
  private transcriptEl: HTMLElement | undefined;
  private renderer: TranscriptRenderer | undefined;
  private statusTextEl: HTMLElement | undefined;
  private stopButton: HTMLButtonElement | undefined;
  private newSessionButton: HTMLButtonElement | undefined;
  private input: HTMLTextAreaElement | undefined;
  private renderScheduled = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: AgentViewHost
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return AGENT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Agent chat";
  }

  override getIcon(): string {
    return "bot";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ys-agent-view");

    const status = root.createDiv({ cls: "ys-agent-status" });
    this.statusTextEl = status.createSpan({ cls: "ys-agent-status-text" });
    this.newSessionButton = status.createEl("button", {
      cls: "ys-agent-status-button",
      attr: { "aria-label": "New session", title: "New session" },
    });
    setIcon(this.newSessionButton, "plus");
    this.newSessionButton.addEventListener("click", () => {
      void this.startNewSession();
    });

    this.transcriptEl = root.createDiv({ cls: "ys-agent-transcript" });

    const composer = root.createDiv({ cls: "ys-agent-composer" });
    const input = composer.createEl("textarea", {
      cls: "ys-agent-input",
      attr: { placeholder: IDLE_PLACEHOLDER, rows: "3" },
    });
    this.input = input;
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const text = input.value.trim();
        if (text.length === 0) return;
        input.value = "";
        this.sendPrompt(text);
        return;
      }
      if (event.key === "Escape" && this.session?.state === "streaming") {
        event.preventDefault();
        this.abort();
      }
    });
    const actions = composer.createDiv({ cls: "ys-agent-composer-actions" });
    this.stopButton = actions.createEl("button", { cls: "ys-agent-stop", text: "Stop" });
    setIcon(this.stopButton.createSpan({ cls: "ys-agent-stop-icon" }), "square");
    this.stopButton.addEventListener("click", () => this.abort());

    try {
      this.session = this.host.acquireSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transcriptEl.createDiv({ cls: "ys-agent-placeholder", text: message });
      input.setAttribute("disabled", "");
      this.newSessionButton.setAttribute("disabled", "");
      return;
    }

    this.renderer = new TranscriptRenderer(
      this.app,
      this,
      this.transcriptEl,
      "Send a prompt to start. The agent runs pi in this vault."
    );
    this.subscriptions.push(
      this.session.onChange(() => this.scheduleRender()),
      this.session.onUiRequest((request) => {
        const session = this.session;
        if (session === undefined) return;
        presentUiRequest(this.app, request, (response) => session.respondUi(response));
      })
    );
    this.scheduleRender();
  }

  override async onClose(): Promise<void> {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.session = undefined;
    this.renderer = undefined;
    await this.host.releaseSession();
    this.contentEl.empty();
  }

  private sendPrompt(text: string): void {
    const session = this.session;
    if (session === undefined) return;
    session.send({ message: text }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Prompt failed: ${message}`);
    });
  }

  private abort(): void {
    const session = this.session;
    if (session === undefined) return;
    session.abort().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Stop failed: ${message}`);
    });
  }

  private async startNewSession(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    if (session.state === "streaming") {
      new Notice("Stop the agent before starting a new session.");
      return;
    }
    try {
      await session.newSession();
      this.input?.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`New session failed: ${message}`);
    }
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  private render(): void {
    const session = this.session;
    const transcriptEl = this.transcriptEl;
    const renderer = this.renderer;
    if (session === undefined || transcriptEl === undefined || renderer === undefined) return;

    const streaming = session.state === "streaming";
    const parts = [`pi: ${session.state}`];
    if (session.detail !== undefined) parts.push(`(${session.detail})`);
    if (session.queuedCount > 0) parts.push(`· ${String(session.queuedCount)} queued`);
    this.statusTextEl?.setText(parts.join(" "));
    this.stopButton?.toggleClass("is-hidden", !streaming);
    this.input?.setAttribute("placeholder", streaming ? STREAMING_PLACEHOLDER : IDLE_PLACEHOLDER);
    this.newSessionButton?.toggleAttribute("disabled", streaming);

    const nearBottom =
      transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
    renderer.render(session.transcript);
    if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
}
