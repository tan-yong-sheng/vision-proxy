---
type: worktree
title: Vision Proxy shared shim
description: Extract common hook-shim helpers into src/shims/shared.mjs to eliminate duplication.
area: backend
tags: [vision-proxy, cli, refactoring, shims]
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-08-28"
related:
  - ../plans/backend-vision-proxy-remaining-debt.md
  - ../worktrees/backend-vision-proxy-gemini-provider.md
---
# Vision Proxy shared shim

## Objective

Remove the two large duplication groups in `src/shims/claude-code-user-prompt-submit.mjs` and `src/shims/codex-user-prompt-submit.mjs` by extracting a shared `src/shims/shared.mjs` module.

## Scope

- Create `src/shims/shared.mjs` exporting:
  - `extractImagePaths(text)` - image path extraction regex passes
  - `failOpen(reason)` - stderr-only fail-open helper
  - `readEvent()` - read and parse JSON event from stdin
  - `runVP(images, extraArgs)` - spawn `vp analyze` with timeout and maxBuffer
  - `emit(description)` - write Claude/Codex hook output JSON
- Update both shims to import from `shared.mjs` and keep their shim-specific arguments (Codex passes `--max-output-tokens`).
- Update `scripts/copy-shims.mjs` to copy `shared.mjs` into `dist/shims/`.
- Keep shebang lines and fail-open behavior unchanged.

## Verification

- `npm run build` succeeds.
- `npm test` passes (29 unit + 3 e2e shim tests).
- `npm run typecheck` passes.
- `fallow audit` exits 0 with fewer duplication groups.

## Status

- [ ] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Merged into integration branch
