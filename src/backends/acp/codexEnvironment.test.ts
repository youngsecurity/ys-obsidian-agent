import { expect, test } from "bun:test";
import { codexEnvironment } from "./codexEnvironment";

test("starts Codex in human-approval mode instead of the adapter's automatic reviewer", () => {
  expect(codexEnvironment({})).toEqual({ INITIAL_AGENT_MODE: "read-only" });
  expect(codexEnvironment({ INITIAL_AGENT_MODE: "agent-full-access" }).INITIAL_AGENT_MODE).toBe("read-only");
});

test("preserves inherited auth and runtime settings without changing the parent environment", () => {
  const inherited = { PATH: "/bin", CODEX_PATH: "/custom/codex", CODEX_API_KEY: "test-value" };
  expect(codexEnvironment(inherited)).toEqual({ ...inherited, INITIAL_AGENT_MODE: "read-only" });
  expect(Object.keys(inherited)).toEqual(["PATH", "CODEX_PATH", "CODEX_API_KEY"]);
});
