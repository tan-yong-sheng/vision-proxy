---
type: worktree
title: "fix pi uninstall message"
description: "Fix the wrong success message when uninstalling the pi integration on the first attempt."
area: backend
tags: [cli, integration, bug, pi]
status: active
branch: fix/pi-uninstall-message
base: main
stack_position: 2
stack_batch: vp-qa-fixes
depends_on:
  - ../worktrees/backend-prune-max-tool-calls-per-turn.md
  - ../worktrees/backend-fix-pi-extension-typebox-dependency.md
  - ../worktrees/backend-tooling-biome-betterleaks.md
created: "2026-08-15"
updated: "2026-08-15"
commits_verified: []
merge_preview_verified: ""
stale_after: "2026-08-29"
related:
  - ../qa/backend-post-merge-qa-for-pr-5.md
  - ../plans/backend-cli-distribution-strategy.md
  - ../plans/backend-fix-pi-uninstall-message.md
  - ../worktrees/backend-fix-hook-shim-shared-mjs-copy.md
  - ../worktrees/backend-prune-max-tool-calls-per-turn.md
  - ../worktrees/backend-fix-pi-extension-typebox-dependency.md
  - ../worktrees/backend-tooling-biome-betterleaks.md
  - ../plans/backend-tooling-biome-betterleaks.md
---
# fix pi uninstall message

## Branch

`fix/pi-uninstall-message` (off `main`).

## Objective

Fix the bug where `vp integration uninstall pi` reports "pi integration was not installed" on the first uninstall attempt even though the extension file exists and is removed.

## Root cause

`integrationUninstall` in `src/commands/integration.ts` sets the `removed` flag only when a host config file is edited. The `pi` agent has no host config file (`configPath()` returns `""`), so the flag stays `false` even after deleting the extension file. The final message branch uses `removed` to decide between "uninstalled" and "was not installed", so pi gets the wrong message.

## Scope

- `src/commands/integration.ts`
- `src/commands/integration.test.ts`

## Tasks

- [ ] Re-apply the corrected `removed` logic in `integrationUninstall` (the prior attempt in `c8852cc` was reverted on `main` by `0031fd0`).
- [ ] Add regression test asserting `uninstalled pi integration` after `pi` install + uninstall.
- [ ] Run `npm test`, `npm run typecheck`, and `fallow audit`.
- [ ] Open PR and merge to `main`.

> NOTE: previously marked done, but the fix was reverted on `main` (`0031fd0` reverted `c8852cc`). The bug is still live. See parent plan `../plans/backend-fix-pi-uninstall-message.md`.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| Unit + e2e tests | `npm test` | 141 tests pass, 0 fail |
| Type check | `npm run typecheck` | clean |
| Manual reproduction | `vp integration install pi && vp integration uninstall pi` | Prints "uninstalled pi integration" |

## Notes

- The bug is still live on `main`: a prior fix (`c8852cc`) was reverted (`0031fd0`). Re-do per `../plans/backend-fix-pi-uninstall-message.md`.
- Do not merge until post-merge QA is complete and any related fixes are batched.
- Related: the hook agents (claude-code, codex) have a separate `shared.mjs` copy bug recorded in `../qa/backend-post-merge-qa-for-pr-5.md` and tracked in `../plans/backend-fix-hook-shim-shared-mjs-copy.md`.
