---
type: worktree
title: Lazy cache pruning
description: Add cacheMaxAgeDays config and lazy age-based pruning to the vision-proxy cache.
area: backend
tags: [post-migration, cache, lazy-pruning]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-08-29"
related: [../plans/backend-vision-proxy-post-migration-feature-set.md]
---
# Lazy cache pruning

## Branch

- **Worktree branch**: `vp-lazy-cache-prune`
- **Base branch**: `configurable-analyze-image-limit`
- **Depends on**: none

## Objective

Add `cacheMaxAgeDays` to the config schema and evict cache entries older than that age lazily on `cacheGet`.

## Scope

`src/core.ts`, `src/cache.ts`, `src/commands/cache.ts`, `src/cache.test.ts`, `src/commands/config.test.ts`

## Tasks

- [ ] Add `cacheMaxAgeDays` to `VisionConfig` and `DEFAULT_CONFIG` (default 30; 0 disables).
- [ ] Add `VP_CACHE_MAX_AGE_DAYS` env override and `vp config set cacheMaxAgeDays <n>` support.
- [ ] Extend `configureCache` to accept `maxAgeDays`; prune in `cacheGet` after `load()`.
- [ ] Keep explicit `vp cache prune` unchanged.
- [ ] Add unit tests covering default pruning, disabled pruning, and fractional-day behavior.

## Verification

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
fallow audit
```

## Dispatch

- **Run**: `run_82079408b671`
- **Task**: `task_7b44d6ff2d0d`
- **Dispatch**: `ctx_e89e21cc145a`
- **Terminal**: `term_2e053fd0-0068-414e-93a6-a15427a1db68`
- **Worktree path**: `/home/tys203831/Documents/Coding/vision-proxy/.worktrees/vp-lazy-cache-prune`

## Status

- [x] Worktree created
- [x] Implementation complete (commit `f12ac2c`)
- [x] Tests pass (74 tests)
- [ ] Merged into integration branch
