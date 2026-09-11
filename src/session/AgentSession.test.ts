import { describe, expect, test } from "bun:test";

import { AgentSession } from "./AgentSession";
import type {
  BackendProcess,
  BackendState,
  ModelInfo,
  PromptInput,
  SessionEvent,
  SessionEventListener,
  UiResponse,
  Unsubscribe,
} from "./types";

/** In-memory backend that records calls and lets tests push events. */
class FakeBackend implements BackendProcess {
  state: BackendState = "ready";
  readonly calls: string[] = [];
  private readonly listeners = new Set<SessionEventListener>();

  subscribe(listener: SessionEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SessionEvent): void {
    if (event.kind === "state_change") this.state = event.state;
    for (const listener of this.listeners) listener(event);
  }

  async prompt(input: PromptInput): Promise<void> {
    this.calls.push(`prompt:${input.message}`);
  }

  async steer(message: string): Promise<void> {
    this.calls.push(`steer:${message}`);
  }

  async followUp(message: string): Promise<void> {
    this.calls.push(`followUp:${message}`);
  }

  async abort(): Promise<void> {
    this.calls.push("abort");
  }

  async newSession(): Promise<void> {
    this.calls.push("newSession");
    this.emit({ kind: "session_reset" });
    this.emit({ kind: "session_info", resumeHandle: "fresh", model: undefined, thinkingLevel: undefined });
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "p", id: "m", name: "M", reasoning: true }];
  }

  async setModel(model: ModelInfo): Promise<void> {
    this.calls.push(`setModel:${model.provider}/${model.id}`);
    this.emit({ kind: "session_info", resumeHandle: "h", model, thinkingLevel: "low" });
  }

  async listThinkingLevels(): Promise<readonly string[]> {
    return ["off", "low"];
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.calls.push(`setThinkingLevel:${level}`);
  }

  respondUi(_response: UiResponse): void {}

  async dispose(): Promise<void> {
    this.calls.push("dispose");
  }
}

describe("AgentSession", () => {
  test("routes send as prompt when idle and steer while streaming", async () => {
    const backend = new FakeBackend();
    const session = new AgentSession(backend);
    await session.send({ message: "first" });
    backend.emit({ kind: "state_change", state: "streaming" });
    await session.send({ message: "second" });
    expect(backend.calls).toEqual(["prompt:first", "steer:second"]);
    expect(session.transcript.map((item) => item.kind)).toEqual(["user", "user"]);
  });

  test("builds assistant, tool, and error cells from events", () => {
    const backend = new FakeBackend();
    const session = new AgentSession(backend);
    backend.emit({ kind: "assistant_message_start" });
    backend.emit({ kind: "thinking_delta", delta: "hmm" });
    backend.emit({ kind: "text_delta", delta: "Hel" });
    backend.emit({ kind: "text_delta", delta: "lo" });
    backend.emit({ kind: "assistant_message_end" });
    backend.emit({
      kind: "tool_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
    });
    backend.emit({ kind: "tool_update", toolCallId: "c1", output: "a" });
    backend.emit({ kind: "tool_end", toolCallId: "c1", output: "a\nb", isError: false });
    backend.emit({ kind: "error", message: "boom" });

    expect(session.transcript).toEqual([
      { kind: "assistant", text: "Hello", thinking: "hmm", complete: true },
      {
        kind: "tool",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "ls" },
        output: "a\nb",
        done: true,
        isError: false,
      },
      { kind: "error", message: "boom" },
    ]);
  });

  test("replayed history lands in the transcript like live events", () => {
    const backend = new FakeBackend();
    const session = new AgentSession(backend);
    backend.emit({ kind: "session_info", resumeHandle: "/tmp/s.jsonl", model: undefined, thinkingLevel: undefined });
    backend.emit({ kind: "user_message", text: "hi" });
    backend.emit({ kind: "assistant_message_start" });
    backend.emit({ kind: "text_delta", delta: "hello" });
    backend.emit({ kind: "assistant_message_end" });

    expect(session.resumeHandle).toBe("/tmp/s.jsonl");
    expect(session.transcript).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello", thinking: "", complete: true },
    ]);
  });

  test("new session clears the transcript and updates the handle", async () => {
    const backend = new FakeBackend();
    const session = new AgentSession(backend);
    backend.emit({ kind: "session_info", resumeHandle: "old", model: undefined, thinkingLevel: undefined });
    backend.emit({ kind: "user_message", text: "hi" });
    await session.newSession();
    expect(backend.calls).toEqual(["newSession"]);
    expect(session.transcript).toEqual([]);
    expect(session.resumeHandle).toBe("fresh");
  });

  test("tracks model and thinking level from session_info", async () => {
    const backend = new FakeBackend();
    const session = new AgentSession(backend);
    expect(session.model).toBeUndefined();
    const [model] = await session.listModels();
    if (model === undefined) throw new Error("fake backend returned no models");
    await session.setModel(model);
    await session.setThinkingLevel("low");
    expect(session.model).toEqual(model);
    expect(session.thinkingLevel).toBe("low");
    expect(backend.calls).toEqual(["setModel:p/m", "setThinkingLevel:low"]);
  });

  test("tracks queued steer and follow-up counts", () => {
    const backend = new FakeBackend();
    const session = new AgentSession(backend);
    backend.emit({ kind: "queue_update", steering: ["a", "b"], followUp: ["c"] });
    expect(session.queuedCount).toBe(3);
    backend.emit({ kind: "queue_update", steering: [], followUp: [] });
    expect(session.queuedCount).toBe(0);
  });

  test("notifies change listeners for transcript and state events", () => {
    const backend = new FakeBackend();
    const session = new AgentSession(backend);
    let changes = 0;
    session.onChange(() => {
      changes += 1;
    });
    backend.emit({ kind: "state_change", state: "streaming" });
    backend.emit({ kind: "user_message", text: "x" });
    backend.emit({ kind: "ui_request", request: { kind: "notify", id: "n", message: "m", level: "info" } });
    expect(changes).toBe(2);
  });
});
