---
type: worktree
title: Remove fallback model retry surface
description: Implementation track for removing fallbackModels from vp analyze.
area: backend
tags: []
status: active
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

- [ ] Remove `fallbackModels` from `VisionConfig`, `DEFAULT_CONFIG`, env parsing, and persisted keys.
- [ ] Remove the fallback candidate loop and `generateWithFallback()` from `analyze.ts`.
- [ ] Update `config.ts` coercion.
- [ ] Update unit tests.
- [ ] Update config documentation.

## Verification

npm test

## Status

- [ ] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
