import { describe, expect, test } from "bun:test";

import { clampOutput, MAX_OUTPUT_CHARS, summarizeArgs } from "./toolSummary";

describe("summarizeArgs", () => {
  test("prefers well-known keys over declaration order", () => {
    expect(summarizeArgs({ content: "body", path: "notes/a.md" })).toBe("notes/a.md");
    expect(summarizeArgs({ path: "x", command: "ls -la" })).toBe("ls -la");
  });

  test("falls back to the first string value and collapses whitespace", () => {
    expect(summarizeArgs({ count: 3, label: "multi\n  line   text" })).toBe("multi line text");
    expect(summarizeArgs({ count: 3 })).toBe("");
  });

  test("joins command arrays and skips identifier keys (codex-style input)", () => {
    expect(
      summarizeArgs({ call_id: "call_1", turn_id: "t", command: ["/bin/bash", "-lc", "ls"], cwd: "/v" })
    ).toBe("/bin/bash -lc ls");
    expect(summarizeArgs({ call_id: "call_1", changes: {} })).toBe("");
  });

  test("truncates long summaries", () => {
    const summary = summarizeArgs({ command: "x".repeat(300) });
    expect(summary.length).toBe(100);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("clampOutput", () => {
  test("passes short output through and truncates long output with a note", () => {
    expect(clampOutput("ok")).toBe("ok");
    const clamped = clampOutput("y".repeat(MAX_OUTPUT_CHARS + 5));
    expect(clamped.startsWith("y".repeat(MAX_OUTPUT_CHARS))).toBe(true);
    expect(clamped.endsWith("(5 more characters truncated)")).toBe(true);
  });
});
