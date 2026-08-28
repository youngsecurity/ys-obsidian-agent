import { FileSystemAdapter, Notice, Platform, Plugin } from "obsidian";

import { getBackendDescriptor, DEFAULT_BACKEND_ID } from "./backends/registry";
import { AgentSession } from "./session/AgentSession";
import { AGENT_VIEW_TYPE, AgentView } from "./ui/AgentView";

/**
 * Plugin entry: view + command registration, lifecycle (composition root).
 *
 * `manifest.json` sets `isDesktopOnly: true`, so Obsidian should never load
 * this on mobile. The explicit guard below covers accidental load paths
 * anyway (design doc gotcha 3).
 *
 * Session lifecycle (milestone 2 AC): the subprocess tree is killed on view
 * close (AgentView.onClose), plugin unload (onunload), and Obsidian quit
 * (best-effort beforeunload signal, since a detached child outlives its
 * parent).
 */
export default class YsObsidianAgentPlugin extends Plugin {
  private session: AgentSession | undefined;

  override async onload(): Promise<void> {
    if (Platform.isMobile) {
      new Notice("YS Obsidian Agent is desktop-only and will not load on mobile.");
      return;
    }

    this.registerView(
      AGENT_VIEW_TYPE,
      (leaf) =>
        new AgentView(leaf, {
          acquireSession: () => this.acquireSession(),
          releaseSession: () => this.releaseSession(),
        })
    );

    this.addCommand({
      id: "open-agent-chat",
      name: "Open agent chat",
      callback: () => {
        void this.activateAgentView();
      },
    });

    this.registerDomEvent(window, "beforeunload", () => {
      // Fires SIGTERM at the subprocess tree synchronously; the async
      // remainder of dispose cannot be awaited during quit.
      void this.releaseSession();
    });
  }

  override onunload(): void {
    void this.releaseSession();
  }

  private acquireSession(): AgentSession {
    if (this.session !== undefined) return this.session;
    const descriptor = getBackendDescriptor(DEFAULT_BACKEND_ID);
    if (descriptor === undefined) {
      throw new Error(`Unknown backend: ${DEFAULT_BACKEND_ID}`);
    }
    const backend = descriptor.createBackendProcess({ vaultRootAbs: this.vaultRootAbs() });
    this.session = new AgentSession(backend);
    return this.session;
  }

  private async releaseSession(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    await session.dispose();
  }

  private vaultRootAbs(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    throw new Error("YS Obsidian Agent requires a local vault (desktop file system).");
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
