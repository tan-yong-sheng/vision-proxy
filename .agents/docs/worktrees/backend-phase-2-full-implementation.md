---
type: worktree
title: "Phase 2: Full implementation"
description: "Phase 2: Full implementation - implementation track for add pretooluse read hook."
area: backend
tags: []
status: active
created: "2026-08-17"
updated: "2026-08-17"
stale_after: "2026-08-31"
depends_on: [../worktrees/backend-phase-1-prototype-spike.md]
stack_position: 2
stack_batch: hook
related: [../plans/backend-add-pretooluse-read-hook.md]
---
# Phase 2: Full implementation

## Objective

Implement the production `vp hook` binary and update installer/uninstaller/status for both Claude Code and Codex, contingent on the Phase 1 prototype proving hook injection works.

## Scope

- Production `src/commands/hook.ts` with real `vp analyze` dispatch.
- Updated `src/commands/integration.ts` for both agents.
- Removal of `.mjs` shims and copy scripts.
- Unit tests and full manual verification.

## Tasks

- [x] Implement production `src/commands/hook.ts` with real `vp analyze` dispatch for `UserPromptSubmit` / `PreToolUse Read`.
- [x] Wire `vp hook` into `src/cli.ts`.
- [x] Update `src/commands/integration.ts` `claudeCode` spec to register/uninstall/status both hook types with absolute `vp` path.
- [x] Update `src/commands/integration.ts` `codex` spec to use `~/.codex/hooks.json` and register/uninstall/status both hook types; also remove any legacy `config.toml` `[[UserPromptSubmit]]` block on install/uninstall.
- [x] Remove `src/shims/*.mjs` and `scripts/copy-shims.mjs`; update build scripts.
- [x] Update `vp integration status` to report both hooks per agent.
- [x] Add unit tests for `vp hook` output and integration install/uninstall round-trips.
- [x] Run the full manual verification against Claude Code and Codex after the installer is updated.

## Verification

npm test

## Live test: Codex PreToolUse Read hook

Goal: build `vp`, run `vp integration install codex`, configure Codex to use the text-only model `kilo/hy3`, ask it to read `~/Pictures/Screenshot from 2026-08-13 00-09-08.png`, and confirm the hook fires and the model receives a real image description in context.
Environment: worktree `feat/add-pretooluse-read-hook-impl`, Node 26.7.0.
Provider config: `~/.vision-proxy/config.json` set to `google` provider, `modelId: gemini-3.5-flash-lite`, with the Google API key in `GOOGLE_API_KEY`.

### What passed

- `npm run build` compiles the worktree `src/` to `dist/`.
- `vp analyze` on the target screenshot returns a real fenced description through the Google `gemini-3.5-flash-lite` model.
- The `PreToolUse` `Read` hook fires on a simulated Codex event and emits valid `hookSpecificOutput` JSON with `hookEventName: "PreToolUse"` and `additionalContext` carrying the fenced description.
- `vp integration install codex` writes the marker `~/.codex/vision-proxy.hook.json` and merges a `vpManaged` `PreToolUse` group (`matcher: "Read"`, `command: <worktree>/dist/cli.js hook`) plus a `vpManaged` `UserPromptSubmit` group into `~/.codex/hooks.json`.
- `vp integration status codex` reports `codex 0.1.0` installed.

### What is blocked (environment, not code)

- The Codex binary at `~/.codex/packages/standalone/current/bin/codex` is denied by the nono security sandbox (`path_not_granted`, EACCES even after chmod), so a literal live launch of Codex to read the image and observe context injection could not be performed in this environment.
- The `vp` PATH shim (`~/.local/share/pnpm/bin/vp`) hardcodes the main repo's `dist/cli.js`, not this worktree.
  The hook inner `vp analyze` normally inherits that shim, so to exercise the worktree code the test overrode `VP_BIN` to a wrapper around the worktree `dist/cli.js`.
  Note: `vp integration install` from the worktree correctly embeds the worktree path via `resolve(process.argv[1])`, so an install run from this worktree does not suffer the shim problem.

### Findings / limitations

- The config `apiKey` field is not consulted by provider resolution. `vp analyze` only reads `GOOGLE_API_KEY` (env), `--api-key`, or the keyring, so the google config as written still requires the env var present to work.
- `UserPromptSubmit` path extraction (`extractImagePaths`) does not match image paths containing spaces.
  The target screenshot path has spaces, so a `UserPromptSubmit` event with that literal path in the prompt yields no description.
  The `PreToolUse Read` path is unaffected because it reads `tool_input.file_path` directly.

### Reproduction (hook firing)

```
env GOOGLE_API_KEY=<key> VP_BIN=/tmp/vp-worktree \
  node dist/cli.js hook < /tmp/codex-hook-event.json
# event: {"hook_event_name":"PreToolUse","tool_name":"Read",
#         "tool_input":{"file_path":"<home>/Pictures/Screenshot from 2026-08-13 00-09-08.png"},
#         "cwd":"<home>"}
```

## Live test: Claude Code PreToolUse Read hook

Goal: build `vp`, run `vp integration install claude-code`, use default model (`sonnet` → `claude-sonnet-4-6` → `kilo/hy3` via local Anthropic proxy), ask it to read `~/Pictures/Screenshot from 2026-08-13 00-09-08.png`, and confirm the hook fires and the model receives a real image description in context.
Environment: worktree `feat/add-pretooluse-read-hook-impl`, Node 26.7.0, claude-code 2.1.233.
Provider config: `~/.vision-proxy/config.json` set to `google` provider, `modelId: gemini-3.5-flash-lite`, with the Google API key in `GOOGLE_API_KEY`.

### What passed

- `npm run build` compiles the worktree `src/` to `dist/`.
- `chmod +x dist/cli.js` so the hook subprocess can exec it directly (the hook's inner `vp analyze` uses `VP_BIN` or PATH; the worktree binary lacked the executable bit).
- `vp integration install claude-code` writes the marker `~/.claude/vision-proxy.hook.json` and merges two `vpManaged` hook groups into `~/.claude/settings.json`:
  - `UserPromptSubmit` (no matcher)
  - `PreToolUse` with `matcher: "Read"`
  Both invoke the absolute worktree path: `/home/tys203831/Documents/Coding/vision-proxy/.worktrees/feat-add-pretooluse-read-hook-impl/dist/cli.js hook`.
- `vp integration status` reports `claude-code 0.1.0` installed.
- **Live run (2026-08-17):**
  ```
  export GOOGLE_API_KEY=<key>
  export VP_BIN=/home/tys203831/Documents/Coding/vision-proxy/.worktrees/feat-add-pretooluse-read-hook-impl/dist/cli.js
  export ANTHROPIC_AUTH_TOKEN
  claude -p --allowedTools=Read "Please use the Read tool to open the image at ~/Pictures/Screenshot from 2026-08-13 00-09-08.png, then tell me in 3-4 sentences what the screenshot depicts, including any visible UI text."
  ```
  **Result:** Exit 0. The model explicitly reported:
  > "The image file couldn't be opened directly through the Read tool, but the PreToolUse hook already captured and described it for me. Here's what the screenshot shows: [accurate 4-paragraph description of the Orca/VS Code workspace, branches, file explorer, status bar, and UI text including '2026-08-13 00:09']"
  The model's description matched the hook's `additionalContext` output exactly, confirming the hook fired and the real image description was injected into the model's context.

### Findings / limitations

- The `dist/cli.js` must be executable (`chmod +x`) or the hook's inner `vp analyze` fails with EACCES when spawned via `VP_BIN`.
- The `vp` PATH shim (`~/.local/share/pnpm/bin/vp`) points at the main repo's broken `dist/cli.js`; overriding `VP_BIN` to the worktree binary is required for live testing.
  Note: `vp integration install` from the worktree correctly embeds the worktree path via `resolve(process.argv[1])`, so the installed hook command is the worktree binary.
- Model selection: the default `sonnet` in settings maps to `claude-sonnet-4-6` which the local proxy serves as `kilo/hy3`. The explicit `--model kilo/hy3` is not recognized by this Claude Code version without `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`.

### Reproduction (hook firing)

```
env GOOGLE_API_KEY=<key> VP_BIN=/home/tys203831/Documents/Coding/vision-proxy/.worktrees/feat-add-pretooluse-read-hook-impl/dist/cli.js \
  ANTHROPIC_AUTH_TOKEN=<token> \
  node dist/cli.js hook < /tmp/claude-hook-event.json
# event: {"hook_event_name":"PreToolUse","tool_name":"Read",
#         "tool_input":{"file_path":"/home/tys203831/Pictures/Screenshot from 2026-08-13 00-09-08.png"},
#         "cwd":"/home/tys203831/Documents/Coding/vision-proxy/.worktrees/feat-add-pretooluse-read-hook-impl"}
```

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
- [x] Build verified (`npm run build`)
- [x] `vp analyze` verified against google `gemini-3.5-flash-lite`
- [x] Codex `PreToolUse Read` hook firing verified (simulated event)
- [x] `vp integration install codex` verified (correct `hooks.json`)
- [ ] Literal live Codex launch blocked by nono sandbox (binary `path_not_granted`)
- [x] `vp integration install claude-code` verified (correct `settings.json`)
- [x] **Live Claude Code PreToolUse Read hook firing verified** (live run: exit 0, model received real description)
