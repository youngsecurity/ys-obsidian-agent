import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";

import type { AgentSession } from "../session/AgentSession";
import { type ModelInfo, modelKey, type Unsubscribe } from "../session/types";
import { TranscriptRenderer } from "./transcriptRenderer";
import { presentUiRequest } from "./uiRequestModals";

export const AGENT_VIEW_TYPE = "ys-agent-chat";

export interface AgentViewHost {
  /** Create or return the live session. Throws when the backend cannot start. */
  acquireSession(): AgentSession;
  /** Dispose the session (kills the subprocess tree, design doc gotcha 6). */
  releaseSession(): Promise<void>;
  /** Dispose and relaunch, resuming the persisted session and current settings. */
  restartSession(): Promise<AgentSession>;
  /** Open this plugin's settings tab. */
  openSettings(): void;
  /** Persist a model chosen in the pane as the default for future launches. */
  rememberModel(model: ModelInfo): Promise<void>;
  /** Persist a thinking level chosen in the pane as the default. */
  rememberThinkingLevel(level: string): Promise<void>;
}

const IDLE_PLACEHOLDER = "Prompt the agent (Enter to send, Shift+Enter for newline)";
const STREAMING_PLACEHOLDER = "Steer the agent (Enter to queue, Esc to stop)";
const TRANSCRIPT_PLACEHOLDER = "Send a prompt to start. The agent runs in this vault.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Chat pane. Reads session-domain types only (docs/design.md layering).
 *
 * Milestone 3 added the trail renderer, steer/stop, and new session.
 * Milestone 4 adds model and thinking pickers in the status bar and crash
 * UX: a banner with Restart when the backend dies, and a startup-failure
 * banner that links to settings when the executable cannot be found.
 */
export class AgentView extends ItemView {
  private session: AgentSession | undefined;
  private readonly subscriptions: Unsubscribe[] = [];
  private renderer: TranscriptRenderer | undefined;
  private transcriptEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private modelButton!: HTMLButtonElement;
  private thinkingButton!: HTMLButtonElement;
  private newSessionButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private input!: HTMLTextAreaElement;
  private renderScheduled = false;
  private restarting = false;
  private bannerMessage: string | undefined;

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
    this.buildDom();
    this.startSession();
  }

  override async onClose(): Promise<void> {
    this.unbindSession();
    await this.host.releaseSession();
    this.contentEl.empty();
  }

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ys-agent-view");

    const status = root.createDiv({ cls: "ys-agent-status" });
    this.statusTextEl = status.createSpan({ cls: "ys-agent-status-text" });
    this.modelButton = status.createEl("button", {
      cls: "ys-agent-status-button ys-agent-picker",
      attr: { title: "Switch model" },
    });
    this.modelButton.addEventListener("click", (event) => {
      void this.openModelMenu(event);
    });
    this.thinkingButton = status.createEl("button", {
      cls: "ys-agent-status-button ys-agent-picker",
      attr: { title: "Thinking level" },
    });
    this.thinkingButton.addEventListener("click", (event) => {
      void this.openThinkingMenu(event);
    });
    this.newSessionButton = status.createEl("button", {
      cls: "ys-agent-status-button",
      attr: { "aria-label": "New session", title: "New session" },
    });
    setIcon(this.newSessionButton, "plus");
    this.newSessionButton.addEventListener("click", () => {
      void this.startNewSession();
    });

    this.bannerEl = root.createDiv({ cls: "ys-agent-banner is-hidden" });
    this.transcriptEl = root.createDiv({ cls: "ys-agent-transcript" });

    const composer = root.createDiv({ cls: "ys-agent-composer" });
    this.input = composer.createEl("textarea", {
      cls: "ys-agent-input",
      attr: { placeholder: IDLE_PLACEHOLDER, rows: "3" },
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const text = this.input.value.trim();
        if (text.length === 0) return;
        this.input.value = "";
        this.sendPrompt(text);
        return;
      }
      if (event.key === "Escape" && this.session?.state === "streaming") {
        event.preventDefault();
        this.abort();
      }
    });
    const actions = composer.createDiv({ cls: "ys-agent-composer-actions" });
    this.stopButton = actions.createEl("button", { cls: "ys-agent-stop is-hidden", text: "Stop" });
    setIcon(this.stopButton.createSpan({ cls: "ys-agent-stop-icon" }), "square");
    this.stopButton.addEventListener("click", () => this.abort());
  }

  private startSession(): void {
    try {
      this.bindSession(this.host.acquireSession());
    } catch (error) {
      this.showStartupFailure(errorMessage(error));
    }
  }

  private bindSession(session: AgentSession): void {
    this.session = session;
    this.transcriptEl.empty();
    this.renderer = new TranscriptRenderer(this.app, this, this.transcriptEl, TRANSCRIPT_PLACEHOLDER);
    this.subscriptions.push(
      session.onChange(() => this.scheduleRender()),
      session.onUiRequest((request) => {
        presentUiRequest(this.app, request, (response) => session.respondUi(response));
      })
    );
    this.scheduleRender();
  }

  private unbindSession(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.session = undefined;
    this.renderer = undefined;
  }

  /** No session could be created (typically: executable not found). */
  private showStartupFailure(message: string): void {
    this.transcriptEl.empty();
    this.statusTextEl.setText("agent: not started");
    this.setControlsEnabled(false);
    this.showBanner(message, [
      { label: "Retry", primary: true, onClick: () => this.startSession() },
      { label: "Open settings", onClick: () => this.host.openSettings() },
    ]);
  }

  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    this.unbindSession();
    this.showBanner("Restarting the agent…", []);
    try {
      this.bindSession(await this.host.restartSession());
    } catch (error) {
      this.showStartupFailure(errorMessage(error));
    } finally {
      this.restarting = false;
    }
  }

  private showBanner(
    message: string,
    actions: readonly { label: string; primary?: boolean; onClick: () => void }[]
  ): void {
    if (this.bannerMessage === message) return;
    this.bannerMessage = message;
    this.bannerEl.empty();
    this.bannerEl.removeClass("is-hidden");
    this.bannerEl.createDiv({ cls: "ys-agent-banner-text", text: message });
    if (actions.length === 0) return;
    const row = this.bannerEl.createDiv({ cls: "ys-agent-banner-actions" });
    for (const action of actions) {
      const button = row.createEl("button", { text: action.label });
      if (action.primary === true) button.addClass("mod-cta");
      button.addEventListener("click", action.onClick);
    }
  }

  private hideBanner(): void {
    if (this.bannerMessage === undefined) return;
    this.bannerMessage = undefined;
    this.bannerEl.addClass("is-hidden");
    this.bannerEl.empty();
  }

  private setControlsEnabled(enabled: boolean): void {
    this.input.toggleAttribute("disabled", !enabled);
    this.setPickersEnabled(enabled);
    this.newSessionButton.toggleAttribute("disabled", !enabled);
  }

  private setPickersEnabled(enabled: boolean): void {
    this.modelButton.toggleAttribute("disabled", !enabled);
    this.thinkingButton.toggleAttribute("disabled", !enabled);
  }

  private sendPrompt(text: string): void {
    const session = this.session;
    if (session === undefined) return;
    session.send({ message: text }).catch((error: unknown) => {
      new Notice(`Prompt failed: ${errorMessage(error)}`);
    });
  }

  private abort(): void {
    const session = this.session;
    if (session === undefined) return;
    session.abort().catch((error: unknown) => {
      new Notice(`Stop failed: ${errorMessage(error)}`);
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
      this.input.focus();
    } catch (error) {
      new Notice(`New session failed: ${errorMessage(error)}`);
    }
  }

  private async openModelMenu(event: MouseEvent): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    let models: readonly ModelInfo[];
    try {
      models = await session.listModels();
    } catch (error) {
      new Notice(`Could not list models: ${errorMessage(error)}`);
      return;
    }
    if (models.length === 0) {
      new Notice("No models are configured for this backend.");
      return;
    }
    const currentKey = session.model === undefined ? undefined : modelKey(session.model);
    const menu = new Menu();
    for (const model of models) {
      menu.addItem((item) =>
        item
          .setTitle(`${model.provider} · ${model.name}`)
          .setChecked(modelKey(model) === currentKey)
          .onClick(() => {
            void this.chooseModel(model);
          })
      );
    }
    menu.showAtMouseEvent(event);
  }

  private async chooseModel(model: ModelInfo): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    try {
      await session.setModel(model);
      await this.host.rememberModel(model);
    } catch (error) {
      new Notice(`Could not switch model: ${errorMessage(error)}`);
    }
  }

  private async openThinkingMenu(event: MouseEvent): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    let levels: readonly string[];
    try {
      levels = await session.listThinkingLevels();
    } catch (error) {
      new Notice(`Could not list thinking levels: ${errorMessage(error)}`);
      return;
    }
    if (levels.length <= 1) {
      new Notice("The current model does not support thinking levels.");
      return;
    }
    const menu = new Menu();
    for (const level of levels) {
      menu.addItem((item) =>
        item
          .setTitle(level)
          .setChecked(level === session.thinkingLevel)
          .onClick(() => {
            void this.chooseThinkingLevel(level);
          })
      );
    }
    menu.showAtMouseEvent(event);
  }

  private async chooseThinkingLevel(level: string): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    try {
      await session.setThinkingLevel(level);
      await this.host.rememberThinkingLevel(level);
    } catch (error) {
      new Notice(`Could not set thinking level: ${errorMessage(error)}`);
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
    const renderer = this.renderer;
    if (session === undefined || renderer === undefined) return;

    const state = session.state;
    const streaming = state === "streaming";
    const down = state === "error" || state === "exited";

    const parts = [`${session.backendName}: ${state}`];
    if (session.queuedCount > 0) parts.push(`· ${String(session.queuedCount)} queued`);
    this.statusTextEl.setText(parts.join(" "));
    this.modelButton.setText(session.model?.name ?? "model…");
    this.thinkingButton.setText(session.thinkingLevel === undefined ? "thinking…" : `thinking: ${session.thinkingLevel}`);

    // Prompts may be typed while pi starts (they queue on stdin); pickers
    // wait for the handshake because there is no model info before it.
    this.input.toggleAttribute("disabled", down);
    this.setPickersEnabled(!down && state !== "starting");
    this.stopButton.toggleClass("is-hidden", !streaming);
    this.input.setAttribute("placeholder", streaming ? STREAMING_PLACEHOLDER : IDLE_PLACEHOLDER);
    this.newSessionButton.toggleAttribute("disabled", down || streaming || state === "starting");

    if (down) {
      const message =
        session.detail ??
        (state === "exited" ? `${session.backendName} exited.` : `${session.backendName} failed.`);
      this.showBanner(message, [{ label: "Restart", primary: true, onClick: () => void this.restart() }]);
    } else if (!this.restarting) {
      this.hideBanner();
    }

    const transcriptEl = this.transcriptEl;
    const nearBottom =
      transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
    renderer.render(session.transcript);
    if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
}
