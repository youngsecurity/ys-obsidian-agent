/** Opt in with YS_TEST_CODEX_MODELS=1. Requires the maintained adapter and Astra access; sends no prompts. */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendProcess, SessionEvent } from "../../session/types";
import { codexBackendDescriptor } from "./index";

function waitForReady(backend: BackendProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Codex startup timed out"));
    }, 30_000);
    const unsubscribe = backend.subscribe((event) => {
      if (event.kind !== "state_change") return;
      if (event.state === "ready" || event.state === "error" || event.state === "exited") {
        clearTimeout(timer);
        unsubscribe();
        if (event.state === "ready") resolve();
        else reject(new Error(event.detail ?? event.state));
      }
    });
  });
}

test.skipIf(process.env["YS_TEST_CODEX_MODELS"] !== "1")(
  "Codex production descriptor lists Astra and switches model and reasoning through config options",
  async () => {
    const vaultRootAbs = mkdtempSync(join(tmpdir(), "ys-codex-model-test-"));
    const backend = codexBackendDescriptor.createBackendProcess({ vaultRootAbs });
    const events: SessionEvent[] = [];
    backend.subscribe((event) => events.push(event));
    try {
      await waitForReady(backend);
      const models = await backend.listModels();
      const astra = models.find((model) => model.id === "gpt-6-astra");
      expect(astra?.name).toBe("6 Astra");
      expect(astra?.description).toContain("complex");
      if (astra === undefined) throw new Error("Astra was not advertised");
      await backend.setModel(astra);
      expect(await backend.listThinkingLevels()).toContain("ultra");
      await backend.setThinkingLevel("ultra");
      const info = [...events].reverse().find((event) => event.kind === "session_info");
      expect(info?.kind === "session_info" ? info.model?.id : undefined).toBe("gpt-6-astra");
      expect(info?.kind === "session_info" ? info.thinkingLevel : undefined).toBe("ultra");
      expect(events.some((event) => event.kind === "error")).toBe(false);
    } finally {
      await backend.dispose();
    }
    expect(backend.state).toBe("exited");
  },
  45_000
);
