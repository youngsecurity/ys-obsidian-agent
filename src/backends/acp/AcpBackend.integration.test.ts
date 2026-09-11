/**
 * Integration test against the real Claude Code ACP adapter. Skipped when
 * `claude-code-acp` is not installed. It sends real prompts, so it needs a
 * logged-in Claude Code; set YS_SKIP_ACP_PROMPTS=1 to run only the
 * handshake and lifecycle parts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEvent } from "../../session/types";
import { detectExecutable, executableNames } from "../shared/detectExecutable";
import { AcpBackendProcess } from "./AcpBackend";
import { claudeCodeBackendDescriptor } from "./index";

const adapterPath = detectExecutable(executableNames("claude-code-acp"));
const describeIfAdapter = adapterPath === null ? describe.skip : describe;
const runPrompts = process.env["YS_SKIP_ACP_PROMPTS"] !== "1";

async function waitFor(
  events: SessionEvent[],
  predicate: (event: SessionEvent) => boolean,
  timeoutMs = 60_000
): Promise<void> {
  const started = Date.now();
  while (!events.some(predicate)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out; saw ${JSON.stringify(events.map((e) => e.kind))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const ready = (e: SessionEvent): boolean => e.kind === "state_change" && e.state === "ready";

describeIfAdapter("AcpBackendProcess (integration, claude-code-acp)", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "ys-acp-it-"));
    writeFileSync(join(workDir, "note.md"), "hello\n");
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("handshake reports models and a session id, new session resets, dispose exits", async () => {
    // Adapter startup takes several seconds; see the explicit timeout below.
    const events: SessionEvent[] = [];
    const backend = new AcpBackendProcess({
      executablePath: adapterPath ?? "claude-code-acp",
      backendId: "claude-code",
      vaultRootAbs: workDir,
    });
    backend.subscribe((event) => events.push(event));
    try {
      await waitFor(events, ready);
      const info = events.find((e) => e.kind === "session_info");
      if (info === undefined || info.kind !== "session_info") throw new Error("no session_info");
      expect(typeof info.resumeHandle).toBe("string");
      expect(info.model).toBeDefined();
      const models = await backend.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]?.provider).toBe("claude-code");

      const before = events.length;
      await backend.newSession();
      const after = events.slice(before).map((e) => e.kind);
      expect(after).toContain("session_reset");
      expect(after[after.length - 1]).toBe("session_info");
    } finally {
      await backend.dispose();
    }
    expect(backend.state).toBe("exited");
  }, 60_000);

  // Opt in on a machine with a current Claude CLI and Fable access. No model
  // prompt is sent: this checks the production descriptor, listing, and selection.
  test.skipIf(process.env["YS_TEST_CLAUDE_RUNTIME"] !== "1")(
    "installed runtime advertises Fable 5.1 and accepts its unchanged model id",
    async () => {
      const events: SessionEvent[] = [];
      const backend = claudeCodeBackendDescriptor.createBackendProcess({ vaultRootAbs: workDir });
      backend.subscribe((event) => events.push(event));
      try {
        await waitFor(events, (e) => ready(e) || (e.kind === "state_change" && e.state === "error"));
        expect(backend.state).toBe("ready");
        const models = await backend.listModels();
        const fable = models.find((model) => model.id === "fable[1m]");
        expect(fable?.description).toContain("Fable 5.1");
        if (fable === undefined) throw new Error("Fable was not advertised");
        const other = models.find((model) => model.id !== fable.id);
        if (other === undefined) throw new Error("No alternate model to switch from");
        await backend.setModel(other);
        await backend.setModel(fable);
        const lastInfo = [...events].reverse().find((e) => e.kind === "session_info");
        expect(lastInfo?.kind === "session_info" ? lastInfo.model : undefined).toEqual(fable);
      } finally {
        await backend.dispose();
      }
    },
    60_000
  );

  test.skipIf(!runPrompts)(
    "prompt streams text and a tool call, then resume replays the history",
    async () => {
      const events: SessionEvent[] = [];
      const backend = new AcpBackendProcess({
        executablePath: adapterPath ?? "claude-code-acp",
        backendId: "claude-code",
        vaultRootAbs: workDir,
      });
      backend.subscribe((event) => events.push(event));
      let handle: string | undefined;
      try {
        await waitFor(events, ready);
        await backend.prompt({
          message: "Run `ls` with your shell tool, then reply with exactly the word DONE and nothing else.",
        });
        await waitFor(events, (e) => e.kind === "state_change" && e.state === "streaming");
        const streamingIndex = events.findIndex((e) => e.kind === "state_change" && e.state === "streaming");
        await waitFor(events, (e) => ready(e) && events.indexOf(e) > streamingIndex, 120_000);
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain("text_delta");
        expect(kinds).toContain("tool_start");
        expect(kinds).toContain("tool_end");
        const text = events
          .filter((e): e is Extract<SessionEvent, { kind: "text_delta" }> => e.kind === "text_delta")
          .map((e) => e.delta)
          .join("");
        expect(text).toContain("DONE");
        const info = [...events].reverse().find((e) => e.kind === "session_info");
        handle = info?.kind === "session_info" ? info.resumeHandle : undefined;
        expect(typeof handle).toBe("string");
      } finally {
        await backend.dispose();
      }

      const replay: SessionEvent[] = [];
      const resumed = new AcpBackendProcess({
        executablePath: adapterPath ?? "claude-code-acp",
        backendId: "claude-code",
        vaultRootAbs: workDir,
        resumeHandle: handle,
      });
      resumed.subscribe((event) => replay.push(event));
      try {
        await waitFor(replay, ready);
      } finally {
        await resumed.dispose();
      }
      const readyIndex = replay.findIndex(ready);
      const history = replay.slice(0, readyIndex).map((e) => e.kind);
      expect(history[0]).toBe("user_message");
      expect(history).toContain("text_delta");
      const info = replay.find((e) => e.kind === "session_info");
      expect(info?.kind === "session_info" ? info.resumeHandle : undefined).toBe(handle);
    },
    180_000
  );
});
