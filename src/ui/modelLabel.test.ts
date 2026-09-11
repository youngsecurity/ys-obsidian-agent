import { expect, test } from "bun:test";
import type { ModelInfo } from "../session/types";
import { modelLabel } from "./modelLabel";

const fable: ModelInfo = { provider: "claude-code", id: "fable[1m]", name: "Fable", reasoning: false };

test("shows the advertised version without changing the selection id", () => {
  expect(modelLabel({ ...fable, description: "Fable 5.1 · Most capable" })).toBe("Fable: Fable 5.1 · Most capable");
  expect(fable.id).toBe("fable[1m]");
});

test("explains Default using the adapter's description, not a guessed model", () => {
  expect(modelLabel({ ...fable, id: "default", name: "Default (recommended)", description: "Sonnet 5 · Efficient" }))
    .toBe("Default (recommended): Sonnet 5 · Efficient");
});

test("keeps the name when no description is available, including pi models", () => {
  expect(modelLabel(fable)).toBe("Fable");
  expect(modelLabel({ ...fable, description: "  " })).toBe("Fable");
  expect(modelLabel({ provider: "anthropic", id: "x", name: "Existing pi model", reasoning: true })).toBe("Existing pi model");
});
