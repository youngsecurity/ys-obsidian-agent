import { type App, type Plugin, PluginSettingTab, Setting } from "obsidian";

import type { BackendDescriptor } from "../session/types";
import { type PluginSettings, THINKING_LEVELS } from "./settings";

export interface SettingsHost {
  getSettings(): PluginSettings;
  /** The backend whose executable the path setting configures. */
  readonly backend: BackendDescriptor;
  saveSettings(next: PluginSettings): Promise<void>;
}

/**
 * Settings tab. Talks to the backend only through its descriptor's
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

    const detection = containerEl.createDiv({ cls: "setting-item-description ys-agent-detection" });
    const renderDetection = (): void => {
      const override = this.host.getSettings().executablePath;
      const resolved = this.host.backend.resolveExecutable(override);
      detection.toggleClass("is-error", resolved === null);
      if (resolved !== null) {
        detection.setText(
          override.trim().length > 0
            ? `Using configured executable: ${resolved}`
            : `Auto-detected ${this.host.backend.displayName} at: ${resolved}`
        );
      } else if (override.trim().length > 0) {
        detection.setText(`Configured path is not runnable: ${override}`);
      } else {
        detection.setText(
          `${this.host.backend.displayName} was not found on PATH or in common install locations. Set the path below.`
        );
      }
    };

    new Setting(containerEl)
      .setName(`${this.host.backend.displayName} executable`)
      .setDesc(
        "Absolute path to the executable. Leave empty to auto-detect (PATH, ~/.bun/bin, ~/.local/bin, /usr/local/bin). Obsidian does not inherit your shell PATH, so set this if detection fails."
      )
      .addText((text) => {
        text
          .setPlaceholder("auto-detect")
          .setValue(this.host.getSettings().executablePath)
          .onChange(async (value) => {
            await this.host.saveSettings({ ...this.host.getSettings(), executablePath: value });
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
        "Model to start sessions with, as provider/id (for example anthropic/claude-sonnet-4-5) or a pattern the backend understands. Leave empty for the backend's own default. Picking a model in the chat pane updates this."
      )
      .addText((text) => {
        text
          .setPlaceholder("backend default")
          .setValue(this.host.getSettings().model)
          .onChange(async (value) => {
            await this.host.saveSettings({ ...this.host.getSettings(), model: value.trim() });
          });
        text.inputEl.addClass("ys-agent-setting-wide");
      });

    new Setting(containerEl)
      .setName("Default thinking level")
      .setDesc(
        "Reasoning effort for models that support it. Leave as backend default to inherit the backend's setting. Picking a level in the chat pane updates this."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", "backend default");
        for (const level of THINKING_LEVELS) dropdown.addOption(level, level);
        dropdown.setValue(this.host.getSettings().thinkingLevel).onChange(async (value) => {
          await this.host.saveSettings({ ...this.host.getSettings(), thinkingLevel: value });
        });
      });

    containerEl.createDiv({
      cls: "setting-item-description",
      text: "Changes apply the next time a session starts. Use Restart in the chat pane or reopen it to apply now.",
    });
  }
}
