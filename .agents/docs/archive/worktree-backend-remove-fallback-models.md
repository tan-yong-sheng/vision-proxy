---
type: worktree
title: Remove fallback model retry surface
description: Implementation track for removing fallbackModels from vp analyze.
area: backend
tags: []
status: landed
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-09-01"
related: [../plans/backend-simplify-analyze-config-surface.md]
---
# Remove fallback model retry surface

## Objective

Remove the `fallbackModels` config/env surface and the retry loop from `vp analyze`, leaving a single primary model call.

## Scope

- `src/core.ts` — drop `fallbackModels` from config, env parsing, and defaults.
- `src/commands/analyze.ts` — remove `generateWithFallback()` and the candidate list.
- `src/commands/config.ts` — remove `fallbackModels` JSON coercion.
- `src/core.test.ts`, `src/commands/analyze.test.ts` — update/remove fallback tests.
- `docs/CONFIG.md` — remove fallbackModels documentation.

## Tasks

- [x] Remove `fallbackModels` from `VisionConfig`, `DEFAULT_CONFIG`, env parsing, and persisted keys.
- [x] Remove the fallback candidate loop and `generateWithFallback()` from `analyze.ts`.
- [x] Update `config.ts` coercion.
- [x] Update unit tests.
- [x] Update config documentation.

## Verification

npm test

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [x] Landed on feature branch (ready for PR/merge)
