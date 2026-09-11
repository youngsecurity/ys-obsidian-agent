/**
 * User settings (docs/design.md `settings/`): executable path, model and
 * thinking defaults. Applied when a backend launches; a running session
 * keeps its current values until restarted.
 */
export interface PluginSettings {
  /** Explicit backend executable. Empty means auto-detect. */
  readonly executablePath: string;
  /** Default model selector (`provider/id` or pattern). Empty means backend default. */
  readonly model: string;
  /** Default thinking level. Empty means backend default. */
  readonly thinkingLevel: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  executablePath: "",
  model: "",
  thinkingLevel: "",
};

/** Full pi thinking scale; the pane narrows to what the model supports. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function stringField(raw: Record<string, unknown>, key: keyof PluginSettings): string {
  const value = raw[key];
  return typeof value === "string" ? value : DEFAULT_SETTINGS[key];
}

export function parseSettings(raw: unknown): PluginSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const record = raw as Record<string, unknown>;
  return {
    executablePath: stringField(record, "executablePath"),
    model: stringField(record, "model"),
    thinkingLevel: stringField(record, "thinkingLevel"),
  };
}
