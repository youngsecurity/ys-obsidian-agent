/**
 * User settings (docs/design.md `settings/`): which backend to run, and per
 * backend the executable path plus model and thinking defaults. Applied when
 * a backend launches; a running session keeps its values until restarted.
 */
export interface BackendSettings {
  /** Explicit backend executable. Empty means auto-detect. */
  readonly executablePath: string;
  /** Default model selector (`provider/id` or pattern). Empty means backend default. */
  readonly model: string;
  /** Default thinking level. Empty means backend default. */
  readonly thinkingLevel: string;
}

export interface PluginSettings {
  /** Id of the backend descriptor to launch (see backends/registry). */
  readonly backendId: string;
  readonly backends: Readonly<Record<string, BackendSettings>>;
}

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  executablePath: "",
  model: "",
  thinkingLevel: "",
};

export const DEFAULT_SETTINGS: PluginSettings = {
  backendId: "pi",
  backends: {},
};

/** Full thinking scale; each backend narrows to what its model supports. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

function stringField(raw: Record<string, unknown>, key: keyof BackendSettings): string {
  const value = raw[key];
  return typeof value === "string" ? value : DEFAULT_BACKEND_SETTINGS[key];
}

function parseBackendSettings(raw: unknown): BackendSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_BACKEND_SETTINGS;
  const record = raw as Record<string, unknown>;
  return {
    executablePath: stringField(record, "executablePath"),
    model: stringField(record, "model"),
    thinkingLevel: stringField(record, "thinkingLevel"),
  };
}

/**
 * Parse persisted settings. Pre-M5 data stored a single flat
 * `{executablePath, model, thinkingLevel}`; that shape migrates to the pi
 * backend's entry.
 */
export function parseSettings(raw: unknown): PluginSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const record = raw as Record<string, unknown>;
  const backends: Record<string, BackendSettings> = {};
  const rawBackends = record["backends"];
  if (typeof rawBackends === "object" && rawBackends !== null) {
    for (const [id, value] of Object.entries(rawBackends)) {
      backends[id] = parseBackendSettings(value);
    }
  } else if ("executablePath" in record || "model" in record || "thinkingLevel" in record) {
    backends["pi"] = parseBackendSettings(record);
  }
  const backendId = typeof record["backendId"] === "string" && record["backendId"].length > 0
    ? record["backendId"]
    : DEFAULT_SETTINGS.backendId;
  return { backendId, backends };
}

/** Settings for one backend, defaulting when none were saved. */
export function backendSettings(settings: PluginSettings, backendId: string): BackendSettings {
  return settings.backends[backendId] ?? DEFAULT_BACKEND_SETTINGS;
}

/** Return settings with one backend's entry replaced. */
export function withBackendSettings(
  settings: PluginSettings,
  backendId: string,
  next: BackendSettings
): PluginSettings {
  return { ...settings, backends: { ...settings.backends, [backendId]: next } };
}
