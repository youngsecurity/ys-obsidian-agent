import type { ToolArgs } from "../session/types";

/** Cap rendered tool output so a huge result cannot stall the pane. */
export const MAX_OUTPUT_CHARS = 20_000;
const MAX_ARG_SUMMARY_CHARS = 100;
/** Argument keys that best identify a tool call, in preference order. */
const SUMMARY_KEYS = [
  "command",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
  "prompt",
  "message",
];

/** One-line description of a tool call taken from its arguments. */
export function summarizeArgs(args: ToolArgs): string {
  let candidate: string | undefined;
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      candidate = value;
      break;
    }
  }
  if (candidate === undefined) {
    for (const value of Object.values(args)) {
      if (typeof value === "string" && value.length > 0) {
        candidate = value;
        break;
      }
    }
  }
  if (candidate === undefined) return "";
  const collapsed = candidate.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_ARG_SUMMARY_CHARS
    ? `${collapsed.slice(0, MAX_ARG_SUMMARY_CHARS - 1)}…`
    : collapsed;
}

/** Truncate long output with a visible note. */
export function clampOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const hidden = output.length - MAX_OUTPUT_CHARS;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (${String(hidden)} more characters truncated)`;
}
