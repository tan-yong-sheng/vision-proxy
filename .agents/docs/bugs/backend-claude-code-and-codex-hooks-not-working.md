---
type: bug
title: claude code and codex hooks not working
description: Claude Code and Codex UserPromptSubmit hooks fail to install or run correctly for vision-proxy.
area: backend
tags: []
status: fixed
created: "2026-08-16"
updated: "2026-08-18"
priority: medium
entry_point: true
stale_after: "2026-09-15"
related:
  - https://github.com/Dicklesworthstone/destructive_command_guard
  - https://github.com/ogulcancelik/herdr
  - ../plans/backend-add-pretooluse-read-hook.md
  - ../research/backend-codex-pretooluse-hook-feasibility-confirmation.md
  - ../research/backend-claude-code-hook-feasibility-openclaude-confirmation.md
  - ../archive/research-backend-claude-code-and-codex-hook-patterns.md
  - ../archive/backend-vision-proxy-hook-shims.md
  - ../archive/plan-backend-binary-as-hook-vision-proxy-integration.md
  - ../archive/backend-vision-proxy-shared-shim.md
---
# claude code and codex hooks not working

## Repro

1. Run `vp integration install claude` (or the equivalent Codex install command) on a fresh project.
2. Submit a user prompt that references an image file path.
3. Observe that the hook either does not fire, does not invoke `vp analyze`, returns an error, or does not inject the image description back into the prompt context.
4. Repeat for `vp integration install codex`.

## Root cause

See ../archive/research-backend-claude-code-and-codex-hook-patterns.md for the investigation and ../plans/backend-add-pretooluse-read-hook.md for the fix plan.

Original hypothesis (superseded by the EACCES finding below):

- The existing `UserPromptSubmit` shim may be failing at install or runtime because of the `./shared.mjs` sidecar dependency, the `node` invocation path, or changes in Claude Code / Codex hook configuration files.
- vision-proxy currently installs only `UserPromptSubmit`; it does not intercept `PreToolUse Read(image_path)` tool calls, which is the second required hook surface.

### Confirmed root cause (2026-08-18): `vp hook` spawns a non-executable `dist/cli.js` with EACCES

When Claude Code runs the installed hook command (`/path/vp hook`), the launcher wrapper does `exec node dist/cli.js hook`. Inside the hook process, `process.argv[1]` is therefore the compiled `dist/cli.js` path, not the `vp` launcher.

`resolveVpBin()` returned that `argv[1]` and `runAnalyze()` spawned it **directly** via `spawnSync`. On the Homebrew install, `dist/cli.js` ships as `0644` (no exec bit) with a hardcoded shebang (`#!/home/.../node@22`), so spawning it as an executable fails with `EACCES` (`errno -13`). The hook's error branch is not `ENOENT`, so it printed `[vision-proxy] vp analyze failed or timed out` and failed open (exit 0, no context). Images never reached the vision model.

Why local dev masked it: `tsc` preserves the `0755` exec bit on the local `dist/cli.js`, so direct-spawning it worked there. The bug only surfaced on packaged installs that strip the exec bit.

## Fix

Implemented in `src/commands/hook.ts`:

- Added `vpEntryToSpawn(cmd)` which, when `cmd` ends in `.js`, returns `{ command: process.execPath, args: [cmd] }` so the entry is re-executed under the already-running node. Non-`.js` paths (the `vp` launcher wrapper/symlink) are returned as-is for direct spawning.
- `runAnalyze` now spawns via the resolved `command`/`prefix` instead of the raw `vp` path.

This is install-method-agnostic: every launcher (`~/.local/bin/vp` via curl installer, Homebrew `libexec/vp`, Windows `vp.cmd`) resolves to a `.js` `argv[1]`, so all three work.

Regression test added: `UserPromptSubmit works when argv[1] is a non-executable .js entry` (writes a `0644` `.js` fake and asserts the hook still emits context).

## Verification

- [x] Reproduced on Homebrew install: `vp hook` failed silently with EACCES before fix.
- [x] `vp integration install claude` creates a working hook (settings.json verified).
- [x] After fix, Homebrew `vp hook` emits `hookSpecificOutput.additionalContext`.
- [x] curl-installer (`~/.local/bin/vp`) and Windows `vp.cmd` paths also resolve via the same `.js` argv[1] and work.
- [x] 17 hook tests pass (incl. new regression test); full suite 166/166 green.
- [ ] Linked to the fix commit / QA dossier once resolved.
