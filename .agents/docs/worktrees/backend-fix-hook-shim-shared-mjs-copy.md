---
type: worktree
title: fix hook shim shared mjs copy
description: "Worktree to fix the Claude Code / Codex hook install writing a shim that imports a missing ./shared.mjs (ESM resolve error at hook runtime)."
area: backend
tags: [cli, integration, bug, hook, shim, claude-code, codex]
status: active
branch: fix/hook-shim-shared-mjs
base: fix/pi-uninstall-message
stack_position: 2
stack_batch: vp-qa-fixes
depends_on:
  - ../worktrees/backend-fix-pi-uninstall-message.md
  - ../worktrees/backend-prune-max-tool-calls-per-turn.md
  - ../worktrees/backend-fix-pi-extension-typebox-dependency.md
  - ../worktrees/backend-tooling-biome-betterleaks.md
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-08-29"
commits_verified: []
merge_preview_verified: ""
related:
  - ../plans/backend-fix-hook-shim-shared-mjs-copy.md
  - ../qa/backend-post-merge-qa-for-pr-5.md
  - ../plans/backend-cli-distribution-strategy.md
  - ../worktrees/backend-fix-pi-uninstall-message.md
  - ../worktrees/backend-prune-max-tool-calls-per-turn.md
  - ../worktrees/backend-fix-pi-extension-typebox-dependency.md
  - ../worktrees/backend-tooling-biome-betterleaks.md
  - ../plans/backend-tooling-biome-betterleaks.md
---
# fix hook shim shared mjs copy

## Objective

Fix `vp integration install claude-code|codex` so it always ships `shared.mjs` next to the generated hook shim. Resolve `shared.mjs` via a `dist/shims` -> `src/shims` fallback and fail loudly if it cannot be found, instead of silently skipping the copy and producing a shim that throws `node:internal/modules/esm/resolve` at hook runtime.

## Scope

- `src/commands/integration.ts` - add `resolveSharedShim()` and use it in `integrationInstall()`.
- `scripts/copy-shims.mjs` - error if `src/shims/shared.mjs` is absent.
- Test: `src/shims/*.e2e.mjs` or `src/commands/integration.test.ts` - assert `shared.mjs` lands next to the installed shim.

## Tools / MCP / Skills

- `node --test` for e2e/unit tests.
- `fallow audit` for change review.
- `git worktree` / `wt` for isolation.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| Install hook into temp dir | `node dist/cli.js integration install claude-code --install-dir <tmp>` | `shared.mjs` present next to shim |
| Shim import resolves | run the generated shim or assert import path exists | no ESM resolve error |
| Full suite | `npm test` | green |
| Type check | `npm run typecheck` | clean |

## Status

- [ ] Implement `resolveSharedShim()` with fallback + throw-on-missing.
- [ ] Wire into `integrationInstall()`.
- [ ] Harden `copy-shims.mjs`.
- [ ] Add e2e regression test.
- [ ] Run `npm test`, `npm run typecheck`, `fallow audit`.
- [ ] Open PR and merge to `main`.

## Open questions

- Should `shared.mjs` travel with the binary in the chosen distribution layout (npm / Homebrew / GitHub release)? Tracked in `../plans/backend-cli-distribution-strategy.md`.
