---
type: worktree
title: Consolidate max image limits
description: Implementation track for collapsing maxImagesPerCall and maxBatch into one limit.
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-09-01"
related: [../plans/backend-simplify-analyze-config-surface.md]
---
# Consolidate max image limits

## Objective

Make `maxImagesPerCall` the single canonical limit for how many images one `vp analyze` call can handle, and deprecate `maxBatch`/`VP_MAX_BATCH`.

## Scope

- `src/core.ts` — make `maxImagesPerCall` the single limit; add one-release `maxBatch` alias.
- `src/commands/analyze.ts` — enforce only `maxImagesPerCall`.
- `src/core.test.ts`, `src/commands/analyze.test.ts` — update limit tests and add deprecation alias test.
- `docs/CONFIG.md` — document the single limit and the deprecation alias.

## Tasks

- [ ] Make `maxImagesPerCall` the canonical limit with default `4`.
- [ ] Support `maxBatch` / `VP_MAX_BATCH` as a fallback alias with a deprecation warning.
- [ ] Update `analyze.ts` limit checks and error messages.
- [ ] Update unit tests.
- [ ] Update config documentation.

## Verification

npm test

## Status

- [x] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
