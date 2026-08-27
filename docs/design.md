# ys-obsidian-agent design

THE agnostic agent in Obsidian. An Obsidian desktop plugin that hosts a real coding-agent harness inside the vault, starting with pi and adding ACP-speaking agents later.

## Motivation

[obsidian-copilot](https://github.com/logancyang/obsidian-copilot) proves the concept but carries constraints this project rejects:

- Skills are discovered and managed inside the vault (`copilot/skills`, `.claude/skills`, builtin seeding, symlink lifecycle, migration flows). This project wants skills to live in the user's global agent environment (`~/.agents/skills`) and never clutter the vault.
- Roughly 277k lines of TypeScript, most of which serves Copilot Plus entitlements, hosted models, Miyo search, LangChain Quick Chat, Projects, and Symposium. None of that is wanted here.
- AGPL-3.0 license. This repo is MIT.

## Licensing constraint (hard rule)

obsidian-copilot is AGPL-3.0. This repo is MIT. **Never copy, port, or mechanically derive code from the copilot fork into this repo.** The fork (`~/github/_youngsecurity-net/ys-obsidian-copilot`) is a reading reference for architecture ideas and Electron gotchas only. All code here is written fresh.

## Goals

1. Chat with a fully capable agent harness inside Obsidian, operating on the vault as its working directory.
2. Inherit the user's existing global agent environment: skills from `~/.agents/skills`, extensions, instructions, provider auth. The plugin manages none of this.
3. Keep the backend boundary clean enough that ACP agents (Claude Code, Codex, opencode, Gemini CLI) can be added later without touching UI or session code.
4. Write nothing into the vault except what the agent itself is asked to write.

## Non-goals

- Skill management UI, skill seeding, or any skill storage in the vault.
- Hosted models, licensing, entitlements, or telemetry.
- A LangChain-style chat pipeline. The harness owns the model loop.
- Mobile support. Subprocess spawning requires desktop (`isDesktopOnly: true`).

## Backend strategy

**Phase 1: pi via RPC mode.** `pi --mode rpc` speaks strict JSONL over stdin/stdout: commands in (`prompt`, `steer`, `follow_up`, `abort`), responses and streamed events out. The pi package ships a subprocess TypeScript client (`src/modes/rpc/rpc-client.ts` in `@earendil-works/pi-coding-agent`), so the framing does not need to be rewritten. Delegating to pi means skills, extensions, AGENTS.md context, provider auth, and session persistence all come from the user's existing global setup for free.

**Phase 2: ACP-generic backend.** The Agent Client Protocol is the same shape: subprocess, JSON-RPC over stdio, streamed session updates. `@agentclientprotocol/sdk` handles the wire protocol. Claude Code (`claude-code-acp`), Codex (`codex-acp`), opencode, and Gemini CLI all speak it. Adding this later is a new `backends/acp/` implementation behind the same contract.

## Architecture

Layered with strict import direction. The contract layer imports nothing from backends or UI.

```
src/
  main.ts                 # plugin entry: view + command registration, lifecycle
  session/                # THE contract layer (backend-agnostic)
    types.ts              # BackendProcess, BackendDescriptor, SessionEvent, BackendState
    AgentSession.ts       # session state machine, event stream, persistence hooks
  backends/
    pi/                   # phase 1: spawn `pi --mode rpc` in vault root
      PiBackend.ts        # BackendProcess impl wrapping the pi RPC client
      detectPi.ts         # executable discovery (see PATH gotcha)
    registry.ts           # the only place that names every backend
  ui/                     # ItemView chat pane; reads session-domain types only
  settings/               # executable path, model/provider/thinking defaults
```

### The contract layer

`session/types.ts` is the seam that makes phase 2 cheap. Design it once, carefully:

- `BackendProcess`: send prompt (with optional images), send steer/follow-up, abort, dispose; emits a stream of `SessionEvent`s; exposes `BackendState` (starting, ready, streaming, error, exited).
- `SessionEvent`: a small domain vocabulary the UI renders. Text deltas, thinking deltas, tool-call started/updated/completed, agent message boundaries, errors, state changes. Each backend translates its native wire format into this vocabulary at its own boundary.
- `BackendDescriptor`: id, display name, availability probe, `createBackendProcess(args)`.

Rules:

- UI imports session types only. UI never imports a backend.
- Backends import session types only. Backends never import UI or each other.
- No backend wire types (pi RPC JSON, ACP SDK types) leak past the backend's own directory.

## Known gotchas (learned by reading copilot, implemented fresh)

1. **PATH.** GUI-launched Obsidian does not inherit the user's shell PATH. `pi` typically lives at `~/.bun/bin/pi`. Ship a configurable executable path in settings plus auto-detection of common install locations (`~/.bun/bin`, `~/.local/bin`, `/usr/local/bin`, `bun pm bin -g` output).
2. **JSONL framing.** Split records on `\n` only, tolerating a trailing `\r`. Node `readline` is not protocol-compliant because it also splits on U+2028 and U+2029, which are valid inside JSON strings. Prefer pi's shipped RPC client; if hand-rolling, use a strict splitter.
3. **Desktop only.** `isDesktopOnly: true` in `manifest.json`. Guard any accidental mobile load path.
4. **cwd = vault root.** Spawn the backend with the vault root as its working directory so file tools and relative paths operate on the vault naturally. Resolve via the adapter's base path, desktop only.
5. **Tool approval UX.** Verify how pi surfaces tool-call gating over RPC before designing any permission UI. Do not assume ACP-style permission requests exist in pi's protocol. Open question, resolve during milestone 2.
6. **Process lifecycle.** Kill the subprocess tree on plugin unload, view close, and Obsidian quit. Handle backend crash with a visible error state and a restart affordance.

## Milestones

1. **Skeleton.** esbuild config, `manifest.json`, TypeScript setup, a bare `ItemView` chat pane, dev vault with hot reload. Bun toolchain.
2. **Pi backend core.** Spawn `pi --mode rpc` in the vault root, send a prompt, render streamed text deltas in the pane. This is the demo-able core.
3. **Trail rendering and control.** Tool calls and results in the transcript, thinking blocks, steer and interrupt, session resume across pane reopen.
4. **Settings and polish.** Pi executable path with auto-detect, model/provider/thinking level selection, error and crash UX.
5. **ACP backend.** `backends/acp/` using `@agentclientprotocol/sdk`, backend picker in settings, availability probing per agent.

## Open questions

- Tool approval semantics over pi RPC (gotcha 5).
- Whether to render with React or plain DOM. Decide at milestone 1 based on how much trail complexity milestone 3 actually needs.
- Session persistence: rely on pi's own session storage (preferred, zero plugin code) versus mirroring a transcript in plugin data for instant pane restore.
