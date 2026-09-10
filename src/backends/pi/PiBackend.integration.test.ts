/**
 * Integration test against a real `pi --mode rpc` subprocess. Skipped when
 * pi is not installed. Never prompts the model, so no provider auth is
 * needed: it exercises the handshake, resume replay, new session, and
 * disposal only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEvent } from "../../session/types";
import { detectPi } from "./detectPi";
import { PiBackendProcess } from "./PiBackend";

const piPath = detectPi();
const describeIfPi = piPath === null ? describe.skip : describe;

function sessionFixture(cwd: string): string {
  const header = { type: "session", version: 3, id: "0000-fixture", timestamp: "2026-01-01T00:00:00.000Z", cwd };
  const entries = [
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "list files" }], timestamp: 1 },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "check the dir" },
          { type: "text", text: "Listing." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fixture",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "a.md\nb.md" }],
        isError: false,
        timestamp: 3,
      },
    },
  ];
  return [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function waitFor(
  events: SessionEvent[],
  predicate: (event: SessionEvent) => boolean,
  timeoutMs = 20_000
): Promise<void> {
  const started = Date.now();
  while (!events.some(predicate)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for event; saw ${JSON.stringify(events.map((e) => e.kind))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeIfPi("PiBackendProcess (integration)", () => {
  let workDir: string;
  let sessionDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "ys-agent-it-"));
    sessionDir = join(workDir, "sessions");
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("handshake reports ready with a resume handle, new session resets", async () => {
    const events: SessionEvent[] = [];
    const backend = new PiBackendProcess({
      executablePath: piPath ?? "pi",
      vaultRootAbs: workDir,
      extraArgs: ["--no-extensions", "--no-skills", "--session-dir", sessionDir],
    });
    backend.subscribe((event) => events.push(event));
    try {
      await waitFor(events, (e) => e.kind === "state_change" && e.state === "ready");
      const info = events.find((e) => e.kind === "session_info");
      expect(info?.kind).toBe("session_info");
      expect(info !== undefined && info.kind === "session_info" && typeof info.resumeHandle === "string").toBe(true);
      const readyIndex = events.findIndex((e) => e.kind === "state_change" && e.state === "ready");
      const infoIndex = events.findIndex((e) => e.kind === "session_info");
      expect(infoIndex).toBeLessThan(readyIndex);

      await backend.newSession();
      const kinds = events.map((e) => e.kind);
      expect(kinds.lastIndexOf("session_reset")).toBeGreaterThan(readyIndex);
      expect(kinds.lastIndexOf("session_info")).toBeGreaterThan(kinds.lastIndexOf("session_reset"));
    } finally {
      await backend.dispose();
    }
    expect(backend.state).toBe("exited");
  });

  test("resume replays stored history before ready", async () => {
    const fixturePath = join(workDir, "fixture.jsonl");
    writeFileSync(fixturePath, sessionFixture(workDir));
    const events: SessionEvent[] = [];
    const backend = new PiBackendProcess({
      executablePath: piPath ?? "pi",
      vaultRootAbs: workDir,
      resumeHandle: fixturePath,
      extraArgs: ["--no-extensions", "--no-skills", "--session-dir", sessionDir],
    });
    backend.subscribe((event) => events.push(event));
    try {
      await waitFor(events, (e) => e.kind === "state_change" && e.state === "ready");
    } finally {
      await backend.dispose();
    }
    const readyIndex = events.findIndex((e) => e.kind === "state_change" && e.state === "ready");
    const replay = events.slice(0, readyIndex).filter((e) => e.kind !== "state_change" && e.kind !== "session_info");
    expect(replay).toEqual([
      { kind: "user_message", text: "list files" },
      { kind: "assistant_message_start" },
      { kind: "thinking_delta", delta: "check the dir" },
      { kind: "text_delta", delta: "Listing." },
      { kind: "assistant_message_end" },
      { kind: "tool_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
      { kind: "tool_end", toolCallId: "call_1", output: "a.md\nb.md", isError: false },
    ]);
    const info = events.find((e) => e.kind === "session_info");
    expect(info !== undefined && info.kind === "session_info" ? info.resumeHandle : undefined).toBe(fixturePath);
  });
});
