---
type: bug
title: Core exposes maxToolCallsPerTurn configuration without enforcement
description: "VisionConfig and env overrides expose maxToolCallsPerTurn but no CLI or adapter path enforces it."
area: backend
tags: [config, dead-code, core, limits]
status: fixed
pre-existing: true
owning_branch: configurable-analyze-image-limit
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-09-14"
related:
  - ../qa/backend-vision-proxy-post-migration-merge-review.md
  - ../research/backend-vision-proxy-review-run-lessons.md
---

# Core exposes maxToolCallsPerTurn configuration without enforcement

## Repro

1. Configure `maxToolCallsPerTurn: 1` in `.vision-proxy.json` or set `VP_MAX_TOOL_CALLS_PER_TURN=1`.
2. Invoke `vp analyze` or use the CLI through agent hooks.
3. Observe that `maxToolCallsPerTurn` is parsed and validated by `src/core.ts` and `src/config.ts`, but no logic in `src/commands/analyze.ts`, `src/adapter.ts`, or hooks ever checks or limits tool invocations based on this parameter.

## Root cause

In `src/core.ts`, `maxToolCallsPerTurn` is a legacy artifact from the original in-process Pi extension architecture. When vision-proxy was migrated to a standalone CLI driven by agent hooks, per-call image limits became controlled by `maxImagesPerCall` and `maxBatch`. Turn-level tool limits are managed by the parent agent harness (Claude Code, Codex, Pi), leaving `maxToolCallsPerTurn` as dead config surface.

## Fix

Prune `maxToolCallsPerTurn` across:
- `VisionConfig` interface in `src/core.ts`
- `DEFAULT_CONFIG` and `CONFIG_KEYS` / `CONFIG_NUMERIC_KEYS` in `src/core.ts`
- `EnvOverrides` and `VP_MAX_TOOL_CALLS_PER_TURN` resolution in `src/core.ts`
- Exported helper function `maxToolCallsPerTurn()` in `src/core.ts`
- Associated tests in `src/core.test.ts` and `src/config.test.ts`

## Verification

1. Run `pnpm test`.
2. Run `pnpm run typecheck`.
3. Run `fallow dead-code --format json --quiet`.

## Regression check

Ensure `loadConfig()`, `resolveConfig()`, and env override mapping continue to function properly without `maxToolCallsPerTurn`.
