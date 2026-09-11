import { describe, expect, test } from "bun:test";

import {
  AcpUpdateTranslator,
  applyConfigOptionUpdate,
  currentModel,
  parseSessionConfig,
  translatePermission,
} from "./translate";

describe("AcpUpdateTranslator", () => {
  test("opens an assistant cell lazily and closes it on tool calls and turn end", () => {
    const t = new AcpUpdateTranslator();
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toEqual([]);
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll run ls" } })).toEqual([
      { kind: "assistant_message_start" },
      { kind: "text_delta", delta: "I'll run ls" },
    ]);
    // Claude Code ACP: announce with placeholder title, refine on the next update.
    expect(
      t.update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        content: [],
        rawInput: {},
      })
    ).toEqual([
      { kind: "assistant_message_end" },
      { kind: "tool_start", toolCallId: "t1", toolName: "Terminal", args: {} },
    ]);
    expect(
      t.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        title: "`ls`",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: "List files" } }],
        rawInput: { command: "ls", description: "List files" },
      })
    ).toEqual([
      {
        kind: "tool_update",
        toolCallId: "t1",
        output: "List files",
        toolName: "`ls`",
        args: { command: "ls", description: "List files" },
      },
    ]);
    expect(
      t.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "note.md" } }],
        rawOutput: "note.md",
      })
    ).toEqual([{ kind: "tool_end", toolCallId: "t1", output: "note.md", isError: false }]);
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DONE" } })).toEqual([
      { kind: "assistant_message_start" },
      { kind: "text_delta", delta: "DONE" },
    ]);
    expect(t.endTurn()).toEqual([{ kind: "assistant_message_end" }]);
    expect(t.endTurn()).toEqual([]);
  });

  test("codex: tool call announced in_progress, diff content, structured rawOutput", () => {
    const t = new AcpUpdateTranslator();
    expect(
      t.update({
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Edit /v/probe-out.txt",
        kind: "edit",
        status: "in_progress",
        content: [{ type: "diff", path: "/v/probe-out.txt", newText: "hi\n" }],
        rawInput: { call_id: "c1", changes: {} },
      })
    ).toEqual([
      { kind: "tool_start", toolCallId: "c1", toolName: "Edit /v/probe-out.txt", args: { call_id: "c1", changes: {} } },
      { kind: "tool_update", toolCallId: "c1", output: "/v/probe-out.txt\nhi\n" },
    ]);
    expect(
      t.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "failed",
        rawOutput: { stdout: "", stderr: "denied", exit_code: 1 },
      })
    ).toEqual([{ kind: "tool_end", toolCallId: "c1", output: "denied", isError: true }]);
  });

  test("buffers replayed user chunks into one message and handles thoughts", () => {
    const t = new AcpUpdateTranslator();
    expect(t.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Reply with" } })).toEqual([]);
    expect(t.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: " PINEAPPLE" } })).toEqual([]);
    expect(t.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "easy" } })).toEqual([
      { kind: "user_message", text: "Reply with PINEAPPLE" },
      { kind: "assistant_message_start" },
      { kind: "thinking_delta", delta: "easy" },
    ]);
    expect(t.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "next" } })).toEqual([
      { kind: "assistant_message_end" },
    ]);
    expect(t.endTurn()).toEqual([{ kind: "user_message", text: "next" }]);
  });

  test("turn end fails tools still running and ignores unrelated updates", () => {
    const t = new AcpUpdateTranslator();
    expect(t.update({ sessionUpdate: "usage_update", used: 1, size: 2 })).toEqual([]);
    expect(t.update({ sessionUpdate: "available_commands_update", availableCommands: [] })).toEqual([]);
    expect(t.update("junk")).toEqual([]);
    t.update({ sessionUpdate: "tool_call", toolCallId: "x", title: "Run", status: "in_progress" });
    expect(t.endTurn()).toEqual([
      { kind: "tool_end", toolCallId: "x", output: "(no result recorded)", isError: true },
    ]);
  });
});

describe("translatePermission", () => {
  test("maps options to a select dialog keyed by option name", () => {
    const result = translatePermission("p1", {
      sessionId: "s",
      toolCall: { toolCallId: "c1", title: "Edit /v/probe-out.txt" },
      options: [
        { optionId: "approved", name: "Yes", kind: "allow_once" },
        { optionId: "abort", name: "No", kind: "reject_once" },
      ],
    });
    expect(result).toEqual({
      request: { kind: "select", id: "p1", title: "Allow: Edit /v/probe-out.txt", options: ["Yes", "No"] },
      choices: [
        { name: "Yes", optionId: "approved" },
        { name: "No", optionId: "abort" },
      ],
    });
    expect(translatePermission("p2", { options: [] })).toBeNull();
  });
});

describe("parseSessionConfig", () => {
  const codex = {
    sessionId: "s",
    configOptions: [
      { id: "mode", category: "mode", type: "select", currentValue: "read-only", options: [{ value: "read-only", name: "Read Only" }] },
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "gpt-5.5",
        options: [
          { value: "gpt-5.5", name: "GPT-5.5" },
          { value: "gpt-5.4", name: "gpt-5.4" },
        ],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [{ value: "low", name: "low" }, { value: "high", name: "high" }],
      },
    ],
  };

  test("reads codex-style configOptions", () => {
    const config = parseSessionConfig(codex, "codex");
    expect(config.modelMechanism).toBe("config_option");
    expect(config.modelConfigId).toBe("model");
    expect(config.models).toEqual([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5", reasoning: false },
      { provider: "codex", id: "gpt-5.4", name: "gpt-5.4", reasoning: false },
    ]);
    expect(currentModel(config)?.id).toBe("gpt-5.5");
    expect(config.thinkingConfigId).toBe("reasoning_effort");
    expect(config.thinkingLevels).toEqual(["low", "high"]);
    expect(config.currentThinkingLevel).toBe("high");
  });

  test("reads claude-style models field and grouped select options", () => {
    const config = parseSessionConfig(
      {
        sessionId: "s",
        models: {
          availableModels: [
            { modelId: "default", name: "Default (recommended)" },
            { modelId: "opus", name: "Opus" },
          ],
          currentModelId: "default",
        },
      },
      "claude-code"
    );
    expect(config.modelMechanism).toBe("set_model");
    expect(config.models.map((m) => m.id)).toEqual(["default", "opus"]);
    expect(currentModel(config)?.name).toBe("Default (recommended)");
    expect(config.thinkingLevels).toEqual([]);

    const grouped = parseSessionConfig(
      {
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "b",
            options: [{ group: "g", name: "G", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }],
          },
        ],
      },
      "x"
    );
    expect(grouped.models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("config_option_update replaces only the categories it carries", () => {
    const base = parseSessionConfig(codex, "codex");
    const updated = applyConfigOptionUpdate(
      base,
      { configOptions: [{ id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "low" }] }] },
      "codex"
    );
    expect(updated.currentThinkingLevel).toBe("low");
    expect(updated.models).toEqual(base.models);
    expect(applyConfigOptionUpdate(base, { configOptions: [] }, "codex")).toBe(base);
  });
});
