---
type: research
title: Lazy cache pruning for vision-proxy
description: Research automatic eviction of stale cache entries for the vision-proxy CLI.
area: backend
tags: []
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-09-13"
related: []
---
# Lazy cache pruning for vision-proxy

## Question

How should `vision-proxy` automatically evict cache entries that are older than a configurable age, without requiring the user to run `vp cache prune`?

## Findings

### Current state

- `src/cache.ts` persists per-image descriptions to a JSON file and keeps them in an in-memory LRU.
- Each record stores `value` and `createdAt`.
- `cacheGet` already refreshes `createdAt` on a hit, so hot entries stay young.
- `cachePrune(maxAgeMs)` exists and is exposed as `vp cache prune [--older <days>]`.

### Option A: lazy pruning on every cache access

On each `cacheGet`, after loading the backing file, scan entries and evict those older than `cacheMaxAgeDays`. Persist only if any entry was removed.

- **Pros**: no background timers, naturally triggered by use, keeps the backing file compact over time, simple to implement.
- **Cons**: small `O(n)` scan on every access (`cacheSize <= 500`, so negligible), a long-idle cache can produce a noticeable prune on its first access.

### Option B: prune during `load()`

`load()` is called by both `cacheGet` and `cacheSet`, so pruning there would also clean the file before writes.

- **Pros**: slightly more eager than Option A; stale entries are removed before new ones are added.
- **Cons**: write amplification on `cacheSet` if the file is persisted even when no hits occurred; still needs a config value passed into the cache module.

### Option C: periodic background pruning

Use `setInterval` to prune every N minutes inside the long-running CLI process.

- **Pros**: predictable.
- **Cons**: CLI processes are short-lived; background timers keep the event loop alive and complicate tests. Not recommended.

### Option D: keep manual pruning only

Leave `vp cache prune` as the only cleanup mechanism.

- **Pros**: zero code change.
- **Cons**: the cache file grows until the user remembers to prune, which conflicts with the "set and forget" goal of hook-driven usage.

### Recommended approach

Combine Option A (lazy prune on access) with a new `cacheMaxAgeDays` config key:

- Add `cacheMaxAgeDays` to `VisionConfig` and `DEFAULT_CONFIG` (default `30`; `0` means disable lazy pruning).
- Add env override `VP_CACHE_MAX_AGE_DAYS` (integer, `0..365`).
- Extend `configureCache(maxEntries, cacheFile?, maxAgeDays?)` and store the value in the cache module.
- In `cacheGet`, after `load()`, call an internal `pruneIfNeeded()` that reuses `cachePrune()`'s age logic but only persists when entries are removed.
- Keep the explicit `vp cache prune` command unchanged for force-pruning.
- Add unit tests covering default age, disabled age (`0`), and fractional-day behavior.

### Edge cases

- `cacheSize` already bounds the number of entries, so age pruning is an additional, not the only, eviction policy.
- Refreshing `createdAt` on hit means frequently used entries survive even a short max age.
- If the user lowers `cacheMaxAgeDays` while old entries exist, the next access prunes them.

## Open questions

1. Should the default be 30 days, 7 days, or follow the hook-budget heuristic from the original extension?
2. Should `cacheMaxAgeDays` support fractional days (e.g., `0.5`) or be integer-only?
3. Should `cacheSet` also trigger pruning, or should reads alone be responsible?
4. Should pruning update `cacheStats().misses` when it removes entries, or keep stats focused on user-initiated lookups?
