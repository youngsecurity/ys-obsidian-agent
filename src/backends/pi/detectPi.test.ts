import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectPi } from "./detectPi";

describe("detectPi", () => {
  let dir: string;
  let runnable: string;
  let notRunnable: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ys-detect-"));
    runnable = join(dir, "pi");
    notRunnable = join(dir, "pi.txt");
    writeFileSync(runnable, "#!/bin/sh\n");
    chmodSync(runnable, 0o755);
    writeFileSync(notRunnable, "");
    chmodSync(notRunnable, 0o644);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses a runnable override as-is", () => {
    expect(detectPi(runnable)).toBe(runnable);
    expect(detectPi(`  ${runnable}  `)).toBe(runnable);
  });

  test("returns null for an override that is not runnable, without falling back", () => {
    expect(detectPi(notRunnable)).toBeNull();
    expect(detectPi(join(dir, "missing"))).toBeNull();
  });

  test("empty override means auto-detect", () => {
    const auto = detectPi();
    expect(detectPi("")).toBe(auto);
    expect(detectPi("   ")).toBe(auto);
  });
});
