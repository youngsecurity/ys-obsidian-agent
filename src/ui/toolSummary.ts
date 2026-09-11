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

/** Opaque identifiers make poor summaries; skip them in the fallback scan. */
function isIdentifierKey(key: string): boolean {
  return key === "id" || key.endsWith("_id") || key.endsWith("Id");
}

/** A string value, or a string array joined as a shell command line. */
function summaryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")) {
    return value.join(" ");
  }
  return undefined;
}

/** One-line description of a tool call taken from its arguments. */
export function summarizeArgs(args: ToolArgs): string {
  let candidate: string | undefined;
  for (const key of SUMMARY_KEYS) {
    candidate = summaryValue(args[key]);
    if (candidate !== undefined) break;
  }
  if (candidate === undefined) {
    for (const [key, value] of Object.entries(args)) {
      if (isIdentifierKey(key)) continue;
      candidate = summaryValue(value);
      if (candidate !== undefined) break;
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
