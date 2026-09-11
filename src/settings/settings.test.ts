import { describe, expect, test } from "bun:test";

import {
  backendSettings,
  DEFAULT_BACKEND_SETTINGS,
  DEFAULT_SETTINGS,
  parseSettings,
  THINKING_LEVELS,
  withBackendSettings,
} from "./settings";

describe("parseSettings", () => {
  test("returns defaults for missing or malformed input", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("x")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ backendId: 5, backends: "no" })).toEqual(DEFAULT_SETTINGS);
  });

  test("migrates the pre-M5 flat shape into the pi entry", () => {
    expect(parseSettings({ executablePath: "/x/pi", model: "a/b", thinkingLevel: "low" })).toEqual({
      backendId: "pi",
      backends: { pi: { executablePath: "/x/pi", model: "a/b", thinkingLevel: "low" } },
    });
  });

  test("keeps per-backend entries and the selected backend", () => {
    const parsed = parseSettings({
      backendId: "codex",
      backends: { codex: { model: "codex/gpt-5.5", junk: 1 }, pi: null },
    });
    expect(parsed.backendId).toBe("codex");
    expect(backendSettings(parsed, "codex")).toEqual({ executablePath: "", model: "codex/gpt-5.5", thinkingLevel: "" });
    expect(backendSettings(parsed, "pi")).toEqual(DEFAULT_BACKEND_SETTINGS);
    expect(backendSettings(parsed, "missing")).toEqual(DEFAULT_BACKEND_SETTINGS);
  });

  test("Codex ultra reasoning can be saved and displayed in the default-level dropdown", () => {
    const settings = parseSettings({ backendId: "codex", backends: { codex: { thinkingLevel: "ultra" } } });
    expect(backendSettings(settings, "codex").thinkingLevel).toBe("ultra");
    expect(THINKING_LEVELS).toContain("ultra");
  });

  test("withBackendSettings replaces one entry immutably", () => {
    const base = parseSettings({ backendId: "pi", backends: { pi: { model: "m" } } });
    const next = withBackendSettings(base, "codex", { ...DEFAULT_BACKEND_SETTINGS, thinkingLevel: "high" });
    expect(next.backends["codex"]?.thinkingLevel).toBe("high");
    expect(next.backends["pi"]?.model).toBe("m");
    expect(base.backends["codex"]).toBeUndefined();
  });
});
