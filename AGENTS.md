# AGENTS.md

Obsidian desktop plugin hosting a real coding-agent harness inside the vault. Pi first via RPC mode, ACP-speaking agents later.

Read [docs/design.md](docs/design.md) before making changes. It defines the architecture, the backend contract, known Electron gotchas, and the milestone plan.

## Hard rules

- **License firewall:** this repo is MIT. The local `ys-obsidian-copilot` fork is AGPL-3.0 and is a reading reference only. Never copy, port, or mechanically derive code from it.
- **Layering:** UI imports session types only. Backends import session types only. No backend wire types leak past the backend's own directory. See docs/design.md.
- **No vault clutter:** the plugin manages no skills and writes nothing into the vault except what the agent is asked to write. Skills come from the user's global `~/.agents/skills` via the harness.

## Toolchain

- Bun for everything: `bun install`, `bun run`, `bun test`, `bunx`.
- TypeScript, esbuild, Obsidian plugin API. Desktop only (`isDesktopOnly: true`).
