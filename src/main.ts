import { Notice, Platform, Plugin } from "obsidian";

import { AGENT_VIEW_TYPE, AgentView } from "./ui/AgentView";

/**
 * Plugin entry: view + command registration, lifecycle.
 *
 * `manifest.json` sets `isDesktopOnly: true`, so Obsidian should never load
 * this on mobile. The explicit guard below covers accidental load paths
 * anyway (design doc gotcha 3).
 */
export default class YsObsidianAgentPlugin extends Plugin {
  override async onload(): Promise<void> {
    if (Platform.isMobile) {
      new Notice("YS Obsidian Agent is desktop-only and will not load on mobile.");
      return;
    }

    this.registerView(AGENT_VIEW_TYPE, (leaf) => new AgentView(leaf));

    this.addCommand({
      id: "open-agent-chat",
      name: "Open agent chat",
      callback: () => {
        void this.activateAgentView();
      },
    });
  }

  private async activateAgentView(): Promise<void> {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0] ?? workspace.getRightLeaf(false);
    if (leaf === null) {
      new Notice("Could not open the agent chat pane.");
      return;
    }
    await leaf.setViewState({ type: AGENT_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }
}
