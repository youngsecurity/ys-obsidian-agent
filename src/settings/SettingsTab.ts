import { type App, type Plugin, PluginSettingTab, Setting } from "obsidian";

import type { BackendDescriptor } from "../session/types";
import {
  backendSettings,
  type PluginSettings,
  THINKING_LEVELS,
  withBackendSettings,
} from "./settings";

export interface SettingsHost {
  getSettings(): PluginSettings;
  /** Every backend the plugin can launch, in picker order. */
  readonly backends: readonly BackendDescriptor[];
  saveSettings(next: PluginSettings): Promise<void>;
}

/**
 * Settings tab. Talks to backends only through their descriptors'
 * `resolveExecutable` probe, so detection status reflects exactly what the
 * launcher will do. Changes take effect on the next session start.
 */
export class AgentSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: SettingsHost
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.host.getSettings();
    const selected =
      this.host.backends.find((backend) => backend.id === settings.backendId) ?? this.host.backends[0];
    if (selected === undefined) {
      containerEl.createEl("p", { text: "No backends are registered." });
      return;
    }

    new Setting(containerEl)
      .setName("Agent backend")
      .setDesc(
        "Which agent runs in the chat pane. pi speaks its own RPC protocol; Claude Code and Codex run through their ACP adapters. Switching takes effect on the next session start."
      )
      .addDropdown((dropdown) => {
        for (const backend of this.host.backends) dropdown.addOption(backend.id, backend.displayName);
        dropdown.setValue(selected.id).onChange(async (value) => {
          await this.host.saveSettings({ ...this.host.getSettings(), backendId: value });
          this.display();
        });
      });

    containerEl.createEl("h3", { text: `${selected.displayName} settings` });
    this.displayBackendSection(containerEl, selected);

    containerEl.createDiv({
      cls: "setting-item-description",
      text: "Changes apply the next time a session starts. Use Restart in the chat pane or reopen it to apply now.",
    });
  }

  private displayBackendSection(containerEl: HTMLElement, backend: BackendDescriptor): void {
    const current = (): PluginSettings => this.host.getSettings();
    const save = async (patch: Partial<ReturnType<typeof backendSettings>>): Promise<void> => {
      const settings = current();
      await this.host.saveSettings(
        withBackendSettings(settings, backend.id, { ...backendSettings(settings, backend.id), ...patch })
      );
    };

    const detection = containerEl.createDiv({ cls: "setting-item-description ys-agent-detection" });
    const renderDetection = (): void => {
      const override = backendSettings(current(), backend.id).executablePath;
      const resolved = backend.resolveExecutable(override);
      detection.toggleClass("is-error", resolved === null);
      if (resolved !== null) {
        detection.setText(
          override.trim().length > 0
            ? `Using configured executable: ${resolved}`
            : `Auto-detected ${backend.displayName} at: ${resolved}`
        );
      } else if (override.trim().length > 0) {
        detection.setText(`Configured path is not runnable: ${override}`);
      } else {
        detection.setText(
          `${backend.displayName} was not found on PATH or in common install locations. Set the path below.`
        );
      }
    };

    new Setting(containerEl)
      .setName(`${backend.displayName} executable`)
      .setDesc(
        "Absolute path to the executable. Leave empty to auto-detect (PATH, ~/.bun/bin, ~/.local/bin, /usr/local/bin). Obsidian does not inherit your shell PATH, so set this if detection fails."
      )
      .addText((text) => {
        text
          .setPlaceholder("auto-detect")
          .setValue(backendSettings(current(), backend.id).executablePath)
          .onChange(async (value) => {
            await save({ executablePath: value });
            renderDetection();
          });
        text.inputEl.addClass("ys-agent-setting-wide");
      })
      .addExtraButton((button) =>
        button
          .setIcon("refresh-cw")
          .setTooltip("Re-run detection")
          .onClick(() => renderDetection())
      );
    containerEl.appendChild(detection);
    renderDetection();

    new Setting(containerEl)
      .setName("Default model")
      .setDesc(
        "Model to start sessions with, as provider/id (for example anthropic/claude-sonnet-4-5 for pi, or codex/gpt-5.5). Leave empty for the backend's own default. Picking a model in the chat pane updates this."
      )
      .addText((text) => {
        text
          .setPlaceholder("backend default")
          .setValue(backendSettings(current(), backend.id).model)
          .onChange(async (value) => {
            await save({ model: value.trim() });
          });
        text.inputEl.addClass("ys-agent-setting-wide");
      });

    new Setting(containerEl)
      .setName("Default thinking level")
      .setDesc(
        "Reasoning effort for models that support it. Leave as backend default to inherit the backend's setting. Backends that do not offer a level ignore this. Picking a level in the chat pane updates this."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", "backend default");
        for (const level of THINKING_LEVELS) dropdown.addOption(level, level);
        dropdown.setValue(backendSettings(current(), backend.id).thinkingLevel).onChange(async (value) => {
          await save({ thinkingLevel: value });
        });
      });
  }
}
