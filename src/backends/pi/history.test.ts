import { describe, expect, test } from "bun:test";

import { translateHistory } from "./history";

describe("translateHistory", () => {
  test("replays user, assistant, and tool messages in transcript order", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me look" },
          { type: "text", text: "Looking." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "a\nb" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      },
    ];

    expect(translateHistory(messages)).toEqual([
      { kind: "user_message", text: "hello" },
      { kind: "assistant_message_start" },
      { kind: "thinking_delta", delta: "let me look" },
      { kind: "text_delta", delta: "Looking." },
      { kind: "assistant_message_end" },
      { kind: "tool_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
      { kind: "tool_end", toolCallId: "call_1", output: "a\nb", isError: false },
      { kind: "assistant_message_start" },
      { kind: "text_delta", delta: "Done." },
      { kind: "assistant_message_end" },
    ]);
  });

  test("user content blocks are joined; image-only messages get a placeholder", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "see " },
          { type: "image", data: "...", mimeType: "image/png" },
          { type: "text", text: "this" },
        ],
      },
      { role: "user", content: [{ type: "image", data: "...", mimeType: "image/png" }] },
    ];
    expect(translateHistory(messages)).toEqual([
      { kind: "user_message", text: "see this" },
      { kind: "user_message", text: "[image]" },
    ]);
  });

  test("closes tool calls that never received a result", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_x", name: "write", arguments: { path: "a.md" } }],
        stopReason: "aborted",
      },
    ];
    expect(translateHistory(messages)).toEqual([
      { kind: "assistant_message_start" },
      { kind: "assistant_message_end" },
      { kind: "tool_start", toolCallId: "call_x", toolName: "write", args: { path: "a.md" } },
      { kind: "tool_end", toolCallId: "call_x", output: "(no result recorded)", isError: true },
    ]);
  });

  test("surfaces assistant errors and renders bash executions as tool cells", () => {
    const messages = [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "rate limited",
      },
      {
        role: "bashExecution",
        command: "pwd",
        output: "/vault",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 5,
      },
    ];
    expect(translateHistory(messages)).toEqual([
      { kind: "assistant_message_start" },
      { kind: "assistant_message_end" },
      { kind: "error", message: "rate limited" },
      { kind: "tool_start", toolCallId: "bash:5", toolName: "bash", args: { command: "pwd" } },
      { kind: "tool_end", toolCallId: "bash:5", output: "/vault", isError: false },
    ]);
  });

  test("ignores malformed entries and unknown roles", () => {
    expect(translateHistory("nope")).toEqual([]);
    expect(translateHistory([null, 42, { role: "custom", content: "x" }, { content: "y" }])).toEqual(
      []
    );
  });
});
