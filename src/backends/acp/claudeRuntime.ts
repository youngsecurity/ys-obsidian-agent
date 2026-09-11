import { detectExecutable, executableNames } from "../shared/detectExecutable";

/**
 * The ACP adapter pins its own Claude SDK/runtime, which can lag behind the
 * user's Claude Code. Its supported CLAUDE_CODE_EXECUTABLE override lets us
 * use the installed CLI while keeping the adapter itself unchanged.
 * Preserve an inherited override exactly; if no CLI is found, use the
 * bundled runtime. Only the child receives this environment.
 */
export function claudeCodeEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  detect: () => string | null = () => detectExecutable(executableNames("claude"))
): NodeJS.ProcessEnv {
  if (inherited["CLAUDE_CODE_EXECUTABLE"]) return { ...inherited };
  const executable = detect();
  return executable === null
    ? { ...inherited }
    : { ...inherited, CLAUDE_CODE_EXECUTABLE: executable };
}
