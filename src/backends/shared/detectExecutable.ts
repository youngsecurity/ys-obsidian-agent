import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Locate a backend executable (design doc gotcha 1). GUI-launched Obsidian
 * does not inherit the user's shell PATH, so after checking whatever PATH
 * exists, fall back to common install locations (`~/.bun/bin` first, where
 * a global bun install puts it). Settings can override with an explicit
 * path; that override is strict (gotcha 10).
 */

/** Expand a leading `~` so users can paste shell-style paths. */
function expandHome(candidate: string): string {
  if (candidate === "~") return homedir();
  if (candidate.startsWith("~/")) return join(homedir(), candidate.slice(2));
  return candidate;
}

export function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirs(): string[] {
  const raw = process.env["PATH"];
  if (raw === undefined || raw.length === 0) return [];
  return raw.split(delimiter).filter((dir) => dir.length > 0);
}

function commonDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

/** Platform-specific file names for a bare executable name. */
export function executableNames(name: string): string[] {
  return process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
}

/**
 * Absolute path to a runnable executable, or `null` when none found.
 * A non-empty override is used as-is (after `~` expansion) and is not
 * subject to auto-detection: if it is not runnable the result is `null`,
 * so a typo surfaces as a clear error instead of silently using another
 * install.
 */
export function detectExecutable(names: readonly string[], override?: string): string | null {
  const trimmed = override?.trim() ?? "";
  if (trimmed.length > 0) {
    const expanded = expandHome(trimmed);
    return isExecutable(expanded) ? expanded : null;
  }
  for (const dir of [...pathDirs(), ...commonDirs()]) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
