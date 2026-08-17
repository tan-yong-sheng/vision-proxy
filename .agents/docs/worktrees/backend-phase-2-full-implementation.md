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

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
