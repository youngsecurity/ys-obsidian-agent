/**
 * Choose human approval rather than the new adapter's automatic reviewer.
 * IMPORTANT: the adapter calls this mode `read-only`, but permits workspace
 * edits. It asks before external-file edits and network access, not every
 * vault write. This migration behavior is documented in docs/design.md.
 * The adapter keeps its compatible bundled Codex unless CODEX_PATH is set.
 */
export function codexEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...inherited, INITIAL_AGENT_MODE: "read-only" };
}
