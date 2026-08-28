import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";

import type { AgentSession, TranscriptItem } from "../session/AgentSession";
import type { Unsubscribe } from "../session/types";
import { presentUiRequest } from "./uiRequestModals";

export const AGENT_VIEW_TYPE = "ys-agent-chat";

export interface AgentViewHost {
  /** Create or return the live session. Throws when the backend cannot start. */
  acquireSession(): AgentSession;
  /** Dispose the session (kills the subprocess tree, design doc gotcha 6). */
  releaseSession(): Promise<void>;
}

/**
 * Chat pane. Reads session-domain types only (docs/design.md layering).
 * Milestone 2 scope: streamed text rendering plus minimal activity lines
 * for tools; the full trail treatment arrives in milestone 3.
 */
export class AgentView extends ItemView {
  private session: AgentSession | undefined;
  private readonly subscriptions: Unsubscribe[] = [];
  private transcriptEl: HTMLElement | undefined;
  private statusEl: HTMLElement | undefined;
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

    this.statusEl = root.createDiv({ cls: "ys-agent-status" });
    this.transcriptEl = root.createDiv({ cls: "ys-agent-transcript" });

    const composer = root.createDiv({ cls: "ys-agent-composer" });
    const input = composer.createEl("textarea", {
      cls: "ys-agent-input",
      attr: { placeholder: "Prompt the agent (Enter to send, Shift+Enter for newline)", rows: "3" },
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const text = input.value.trim();
        if (text.length === 0) return;
        input.value = "";
        this.sendPrompt(text);
      }
    });

    try {
      this.session = this.host.acquireSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transcriptEl.createDiv({ cls: "ys-agent-placeholder", text: message });
      input.setAttribute("disabled", "");
      return;
    }

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
    const statusEl = this.statusEl;
    if (session === undefined || transcriptEl === undefined || statusEl === undefined) return;

    statusEl.setText(
      session.detail === undefined ? `pi: ${session.state}` : `pi: ${session.state} (${session.detail})`
    );

    const nearBottom =
      transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
    transcriptEl.empty();
    if (session.transcript.length === 0) {
      transcriptEl.createDiv({
        cls: "ys-agent-placeholder",
        text: "Send a prompt to start. The agent runs pi in this vault.",
      });
    }
    for (const item of session.transcript) {
      this.renderItem(transcriptEl, item);
    }
    if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  private renderItem(parent: HTMLElement, item: TranscriptItem): void {
    switch (item.kind) {
      case "user":
        parent.createDiv({ cls: "ys-agent-cell ys-agent-user", text: item.text });
        return;
      case "assistant": {
        const cell = parent.createDiv({ cls: "ys-agent-cell ys-agent-assistant" });
        if (item.thinking.length > 0) {
          cell.createDiv({ cls: "ys-agent-thinking", text: item.thinking });
        }
        cell.createDiv({
          cls: "ys-agent-text",
          text: item.complete ? item.text : `${item.text}▌`,
        });
        return;
      }
      case "tool": {
        const status = item.done ? (item.isError ? "failed" : "done") : "running…";
        parent.createDiv({
          cls: "ys-agent-cell ys-agent-tool",
          text: `⚙ ${item.toolName} ${status}`,
        });
        return;
      }
      case "error":
        parent.createDiv({ cls: "ys-agent-cell ys-agent-error", text: item.message });
        return;
      default: {
        const _exhaustive: never = item;
        void _exhaustive;
      }
    }
  }
}
