import { describe, expect, test } from "bun:test";

import { parsePiWireEvent } from "./wire";

describe("parsePiWireEvent", () => {
  test("parses text deltas from message_update", () => {
    const line = JSON.stringify({
      type: "message_update",
      usage: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
    });
    expect(parsePiWireEvent(line)).toEqual({ type: "text_delta", delta: "Hello " });
  });

  test("parses thinking deltas", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
    });
    expect(parsePiWireEvent(line)).toEqual({ type: "thinking_delta", delta: "hmm" });
  });

  test("ignores non-delta message_update variants", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    expect(parsePiWireEvent(line)).toBeNull();
  });

  test("keeps assistant message boundaries and drops user ones", () => {
    const assistant = JSON.stringify({ type: "message_start", message: { role: "assistant" } });
    const user = JSON.stringify({ type: "message_start", message: { role: "user" } });
    expect(parsePiWireEvent(assistant)).toEqual({ type: "assistant_message_start" });
    expect(parsePiWireEvent(user)).toBeNull();
  });

  test("parses tool execution lifecycle with content text", () => {
    const start = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls" },
    });
    const update = JSON.stringify({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    const end = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });
    expect(parsePiWireEvent(start)).toEqual({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
    });
    expect(parsePiWireEvent(update)).toEqual({
      type: "tool_execution_update",
      toolCallId: "call_1",
      text: "partial",
    });
    expect(parsePiWireEvent(end)).toEqual({
      type: "tool_execution_end",
      toolCallId: "call_1",
      text: "done",
      isError: false,
    });
  });

  test("parses responses including failures", () => {
    const ok = JSON.stringify({ type: "response", id: "r1", command: "get_state", success: true });
    const fail = JSON.stringify({
      type: "response",
      command: "set_model",
      success: false,
      error: "Model not found",
    });
    expect(parsePiWireEvent(ok)).toEqual({
      type: "response",
      id: "r1",
      command: "get_state",
      success: true,
      error: undefined,
    });
    expect(parsePiWireEvent(fail)).toEqual({
      type: "response",
      id: undefined,
      command: "set_model",
      success: false,
      error: "Model not found",
    });
  });

  test("passes extension_ui_request through raw", () => {
    const line = JSON.stringify({
      type: "extension_ui_request",
      id: "uuid-1",
      method: "confirm",
      title: "Allow?",
    });
    const parsed = parsePiWireEvent(line);
    expect(parsed?.type).toBe("extension_ui_request");
  });

  test("returns null for malformed json and unknown events", () => {
    expect(parsePiWireEvent("not json")).toBeNull();
    expect(parsePiWireEvent('{"type":"queue_update"}')).toBeNull();
    expect(parsePiWireEvent('{"no":"type"}')).toBeNull();
  });
});
