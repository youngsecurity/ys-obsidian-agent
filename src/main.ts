import { FileSystemAdapter, Notice, Platform, Plugin } from "obsidian";

import { getBackendDescriptor, DEFAULT_BACKEND_ID } from "./backends/registry";
import { AgentSession } from "./session/AgentSession";
import { type BackendDescriptor, type ModelInfo, modelKey } from "./session/types";
import { AgentSettingsTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, parseSettings, type PluginSettings } from "./settings/settings";
import { AGENT_VIEW_TYPE, AgentView } from "./ui/AgentView";

/** Persisted plugin data. Resume handles are opaque and keyed by backend id. */
interface PluginData {
  readonly resumeHandles: Readonly<Record<string, string>>;
  readonly settings: PluginSettings;
}

const DEFAULT_DATA: PluginData = { resumeHandles: {}, settings: DEFAULT_SETTINGS };

function parsePluginData(raw: unknown): PluginData {
  if (typeof raw !== "object" || raw === null) return DEFAULT_DATA;
  const record = raw as Record<string, unknown>;
  const handles = record["resumeHandles"];
  const resumeHandles: Record<string, string> = {};
  if (typeof handles === "object" && handles !== null) {
    for (const [key, value] of Object.entries(handles)) {
      if (typeof value === "string") resumeHandles[key] = value;
    }
  }
  return { resumeHandles, settings: parseSettings(record["settings"]) };
}

/**
 * Obsidian's settings pane is not in the public typings. Narrow at runtime
 * so a missing API degrades to a Notice instead of a crash.
 */
function openPluginSettings(app: unknown, pluginId: string): boolean {
  const setting = (app as { setting?: unknown }).setting;
  if (typeof setting !== "object" || setting === null) return false;
  const api = setting as { open?: () => void; openTabById?: (id: string) => void };
  if (typeof api.open !== "function" || typeof api.openTabById !== "function") return false;
  api.open();
  api.openTabById(pluginId);
  return true;
}

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
 *
 * Session resume (milestone 3): the backend's own session storage is the
 * source of truth. The plugin persists only the opaque resume handle the
 * backend reports and hands it back on the next launch, so reopening the
 * pane (or restarting Obsidian) replays the same conversation.
 *
 * Settings (milestone 4): executable path, default model, and thinking
 * level are passed as launch args. Picks made in the pane are written back
 * as the new defaults.
 */
export default class YsObsidianAgentPlugin extends Plugin {
  private session: AgentSession | undefined;
  private data: PluginData = DEFAULT_DATA;

  override async onload(): Promise<void> {
    if (Platform.isMobile) {
      new Notice("YS Obsidian Agent is desktop-only and will not load on mobile.");
      return;
    }

    this.data = parsePluginData(await this.loadData());
    const backend = this.backendDescriptor();

    this.registerView(
      AGENT_VIEW_TYPE,
      (leaf) =>
        new AgentView(leaf, {
          acquireSession: () => this.acquireSession(),
          releaseSession: () => this.releaseSession(),
          restartSession: () => this.restartSession(),
          openSettings: () => this.openSettings(),
          rememberModel: (model) => this.rememberModel(model),
          rememberThinkingLevel: (level) => this.rememberThinkingLevel(level),
        })
    );

    this.addSettingTab(
      new AgentSettingsTab(this.app, this, {
        getSettings: () => this.data.settings,
        backend,
        saveSettings: (next) => this.saveSettings(next),
      })
    );

    this.addCommand({
      id: "open-agent-chat",
      name: "Open agent chat",
      callback: () => {
        void this.activateAgentView();
      },
    });

    this.addCommand({
      id: "new-agent-session",
      name: "Start a new agent session",
      callback: () => {
        void this.startNewSession();
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

  private backendDescriptor(): BackendDescriptor {
    const descriptor = getBackendDescriptor(DEFAULT_BACKEND_ID);
    if (descriptor === undefined) {
      throw new Error(`Unknown backend: ${DEFAULT_BACKEND_ID}`);
    }
    return descriptor;
  }

  private acquireSession(): AgentSession {
    if (this.session !== undefined) return this.session;
    const descriptor = this.backendDescriptor();
    const settings = this.data.settings;
    const resumeHandle = this.data.resumeHandles[descriptor.id];
    const backend = descriptor.createBackendProcess({
      vaultRootAbs: this.vaultRootAbs(),
      ...(resumeHandle === undefined ? {} : { resumeHandle }),
      executablePath: settings.executablePath,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
    });
    const session = new AgentSession(backend);
    session.onChange(() => {
      void this.rememberResumeHandle(descriptor.id, session.resumeHandle);
    });
    this.session = session;
    return session;
  }

  private async releaseSession(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    await session.dispose();
  }

  private async restartSession(): Promise<AgentSession> {
    await this.releaseSession();
    return this.acquireSession();
  }

  private async rememberResumeHandle(backendId: string, handle: string | undefined): Promise<void> {
    if (handle === undefined || this.data.resumeHandles[backendId] === handle) return;
    this.data = { ...this.data, resumeHandles: { ...this.data.resumeHandles, [backendId]: handle } };
    await this.saveData(this.data);
  }

  private async saveSettings(next: PluginSettings): Promise<void> {
    this.data = { ...this.data, settings: next };
    await this.saveData(this.data);
  }

  private rememberModel(model: ModelInfo): Promise<void> {
    return this.saveSettings({ ...this.data.settings, model: modelKey(model) });
  }

  private rememberThinkingLevel(level: string): Promise<void> {
    return this.saveSettings({ ...this.data.settings, thinkingLevel: level });
  }

  private openSettings(): void {
    if (!openPluginSettings(this.app, this.manifest.id)) {
      new Notice("Open Settings → Community plugins → YS Obsidian Agent.");
    }
  }

  private async startNewSession(): Promise<void> {
    await this.activateAgentView();
    const session = this.session;
    if (session === undefined) return;
    if (session.state === "streaming") {
      new Notice("Stop the agent before starting a new session.");
      return;
    }
    try {
      await session.newSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`New session failed: ${message}`);
    }
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
