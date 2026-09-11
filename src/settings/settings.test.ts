import { describe, expect, test } from "bun:test";

import { DEFAULT_SETTINGS, parseSettings } from "./settings";

describe("parseSettings", () => {
  test("returns defaults for missing or malformed input", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("x")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ executablePath: 5 })).toEqual(DEFAULT_SETTINGS);
  });

  test("keeps string fields and ignores unknown ones", () => {
    expect(parseSettings({ executablePath: "/x/pi", model: "a/b", thinkingLevel: "low", junk: 1 })).toEqual({
      executablePath: "/x/pi",
      model: "a/b",
      thinkingLevel: "low",
    });
  });
});
