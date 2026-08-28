import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Locate the pi executable (design doc gotcha 1). GUI-launched Obsidian does
 * not inherit the user's shell PATH, so after checking whatever PATH exists,
 * fall back to common install locations (`~/.bun/bin` first, where a global
 * bun install puts it). A user-configurable override lands in milestone 4.
 */
const EXECUTABLE_NAMES = process.platform === "win32" ? ["pi.exe", "pi.cmd"] : ["pi"];

function isExecutable(candidate: string): boolean {
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
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

/** Absolute path to a runnable pi executable, or `null` when none found. */
export function detectPi(): string | null {
  for (const dir of [...pathDirs(), ...commonDirs()]) {
    for (const name of EXECUTABLE_NAMES) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
