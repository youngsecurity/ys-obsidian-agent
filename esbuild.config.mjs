import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const prod = process.argv.includes("production");

/**
 * Production builds emit main.js at the repo root (release layout).
 * Dev builds emit straight into the dev vault's plugin directory and
 * keep manifest.json/styles.css/.hotreload in sync so the hot-reload
 * plugin picks up every rebuild.
 */
const devVaultPluginDir = path.join("dev-vault", ".obsidian", "plugins", "ys-obsidian-agent");
const outdir = prod ? "." : devVaultPluginDir;

const syncPluginFiles = () => {
  if (prod) return;
  mkdirSync(outdir, { recursive: true });
  copyFileSync("manifest.json", path.join(outdir, "manifest.json"));
  copyFileSync("styles.css", path.join(outdir, "styles.css"));
  writeFileSync(path.join(outdir, ".hotreload"), "");
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  outfile: path.join(outdir, "main.js"),
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  treeShaking: true,
  sourcemap: prod ? false : "inline",
  logLevel: "info",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  plugins: [
    {
      name: "sync-plugin-files",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) syncPluginFiles();
        });
      },
    },
  ],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
