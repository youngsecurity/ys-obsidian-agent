import { ItemView, type WorkspaceLeaf } from "obsidian";

export const AGENT_VIEW_TYPE = "ys-agent-chat";

/**
 * Bare chat pane (milestone 1). Renders a transcript area and a composer.
 * The composer stays disabled until a backend is connected (milestone 2);
 * this view will then read session-domain types only, per the layering
 * rules in docs/design.md.
 */
export class AgentView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
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

    const transcript = root.createDiv({ cls: "ys-agent-transcript" });
    transcript.createDiv({
      cls: "ys-agent-placeholder",
      text: "No backend connected yet. The pi backend arrives in milestone 2.",
    });

    const composer = root.createDiv({ cls: "ys-agent-composer" });
    composer.createEl("textarea", {
      cls: "ys-agent-input",
      attr: {
        placeholder: "Prompt (disabled until a backend is connected)",
        rows: "3",
        disabled: "",
      },
    });
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
