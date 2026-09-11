import { expect, test } from "bun:test";
import { claudeCodeEnvironment } from "./claudeRuntime";

test("uses the installed runtime and preserves the inherited environment without mutation", () => {
  const inherited = { PATH: "/bin", ANTHROPIC_API_KEY: "test-value" };
  expect(claudeCodeEnvironment(inherited, () => "/home/test/.local/bin/claude")).toEqual({
    ...inherited, CLAUDE_CODE_EXECUTABLE: "/home/test/.local/bin/claude",
  });
  expect(Object.keys(inherited)).toEqual(["PATH", "ANTHROPIC_API_KEY"]);
});

test("honors an explicit runtime override without probing or falling back", () => {
  const inherited = { CLAUDE_CODE_EXECUTABLE: "/custom/claude" };
  const env = claudeCodeEnvironment(inherited, () => { throw new Error("must not probe"); });
  expect(env).toEqual(inherited);
  expect(env).not.toBe(inherited);
});

test("keeps the adapter's bundled runtime when no CLI is installed", () => {
  expect(claudeCodeEnvironment({ PATH: "/bin" }, () => null)).toEqual({ PATH: "/bin" });
});
