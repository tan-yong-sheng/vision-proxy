---
type: plan
title: Simplify analyze config surface
description: "Remove fallbackModels and consolidate maxImagesPerCall/maxBatch into a single, simpler analyze configuration surface."
area: backend
tags: []
status: complete
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-10-17"
related: []
---
# Simplify analyze config surface

## Goal capsule

Remove two pieces of unused or redundant configuration from `vp analyze`:

1. The `fallbackModels` retry mechanism.
2. The overlapping `maxImagesPerCall` / `maxBatch` limits.

This reduces CLI complexity and makes the effective multi-image limit obvious.

## Current state

- `src/core.ts` defines `fallbackModels`, `VP_FALLBACK_MODELS`, and validation for a list of `provider/modelId` fallback candidates.
- `src/commands/analyze.ts` builds a candidate list (primary + fallbacks) and loops through them in `generateWithFallback()`, retrying on runtime failures.
- `src/core.ts` also defines `maxImagesPerCall` (default `10`) and `maxBatch` (default `4`).
- `src/commands/analyze.ts` rejects any call where `imagePaths.length` exceeds either limit, so the practical cap is `min(10, 4) = 4`.
- `docs/CONFIG.md` documents `maxImagesPerCall` with a default of `4`, which already drifts from the code.
- The `UserPromptSubmit` hook already passes multiple extracted image paths to one `vp analyze` invocation; the adapter sends them in a single user message (one LLM API call). The joint behavior works - the dual limit is the part that needs cleaning up.

## Target state

- No `fallbackModels` field, env var, or persisted config key.
- `vp analyze` resolves one model and makes one call; retries are gone.
- A single limit named `maxImagesPerCall` governs how many images one `vp analyze` call may receive.
- Default `maxImagesPerCall` is `4`, preserving today's effective behavior for multi-image prompts.
- `maxBatch` and `VP_MAX_BATCH` become deprecated aliases for one release: if `maxImagesPerCall` is unset and `maxBatch` is set, use `maxBatch` and emit a deprecation warning.

## Key technical decisions

- **Canonical limit:** `maxImagesPerCall` because the name describes the actual model/API constraint.
- **Default value:** `4` to match the current effective ceiling and avoid surprising cost/timeout changes in agent hooks.
- **Deprecation, not removal, for `maxBatch`:** keeps existing configs working during a grace period.
- **Keep `--joint` flag:** it still forces the joint path for a single image and is independent of the limit cleanup.
- **Hook behavior:** no change to the joint path; the hook will simply hit the clearer `maxImagesPerCall` limit.

## Deliverables

- `feat/remove-fallback-models`
  - Remove `fallbackModels` from `VisionConfig`, `DEFAULT_CONFIG`, env parsing, persisted keys, and `sanitize()`.
  - Remove the fallback-candidate loop and `generateWithFallback()` from `src/commands/analyze.ts`.
  - Update `src/commands/config.ts` coercion logic.
  - Remove/update tests in `src/core.test.ts` and `src/commands/analyze.test.ts`.
  - Update `docs/CONFIG.md`.

- `feat/consolidate-max-image-limits`
  - Make `maxImagesPerCall` the single canonical limit in `src/core.ts`.
  - Add a one-release alias for `maxBatch` / `VP_MAX_BATCH`.
  - Update the limit checks in `src/commands/analyze.ts`.
  - Update tests and defaults in `src/core.test.ts` / `src/commands/analyze.test.ts`.
  - Update `docs/CONFIG.md` to document one limit.

## Worktree Strategy

Two parallel worktrees, both branched from current `dev` and targeting `dev` on completion.

### `feat/remove-fallback-models` — Remove fallback model retry surface

- **Branch:** `feat/remove-fallback-models`
- **Objective:** Strip `fallbackModels` from config/env and remove the retry loop in `analyze.ts`.
- **Scope & Files:** `src/core.ts`, `src/commands/analyze.ts`, `src/commands/config.ts`, `src/core.test.ts`, `src/commands/analyze.test.ts`, `docs/CONFIG.md`.
- **Depends On:** none
- **Verification Criteria:** `npm test`, `npm run typecheck`.

### `feat/consolidate-max-image-limits` — Consolidate max image limits

- **Branch:** `feat/consolidate-max-image-limits`
- **Objective:** Make `maxImagesPerCall` the single canonical limit and deprecate `maxBatch`/`VP_MAX_BATCH`.
- **Scope & Files:** `src/core.ts`, `src/commands/analyze.ts`, `src/core.test.ts`, `src/commands/analyze.test.ts`, `docs/CONFIG.md`.
- **Depends On:** none
- **Verification Criteria:** `npm test`, `npm run typecheck`.

## Risks

- **Breaking config surface:** removing `fallbackModels` and eventually `maxBatch` breaks existing configs/env vars. Mitigation: deprecate `maxBatch` for one release; document the `fallbackModels` removal in release notes.
- **Loss of runtime resilience:** without fallback models, a primary model outage/rate-limit fails the call. The current fallback path was already opt-in (default empty), so most users will not notice.
- **Test churn:** both changes require updating existing tests and possibly adding new ones for the deprecation alias.
- **Hook multi-image regressions:** consolidating limits must not accidentally reduce the number of images the hook can handle below today's effective `4`.

## Tools / MCP / Skills

- `agents-docs` for plan and worktree flight logs.
- `worktrunk-orca-delegation` for parallel worktree dispatch.
- `review-gate` for pre-merge verification.
