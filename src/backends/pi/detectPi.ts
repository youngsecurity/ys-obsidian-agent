import { detectExecutable, executableNames } from "../shared/detectExecutable";

const PI_NAMES = executableNames("pi");

/** Absolute path to a runnable pi executable, or `null` when none found. */
export function detectPi(override?: string): string | null {
  return detectExecutable(PI_NAMES, override);
}
