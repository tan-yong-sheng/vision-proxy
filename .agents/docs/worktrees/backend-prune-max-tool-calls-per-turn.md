---
type: worktree
title: prune max tool calls per turn
description: "Prune the dead maxToolCallsPerTurn config surface from core, config, and tests."
area: backend
tags: [cli, config, dead-code, core, limits]
status: active
branch: configurable-analyze-image-limit
base: main
stack_position: 1
stack_batch: vp-pre-existing-bugs
created: "2026-08-15"
updated: "2026-08-15"
commits_verified: []
merge_preview_verified: ""
stale_after: "2026-08-29"
related:
  - ../bugs/backend-core-dead-max-tool-calls-per-turn-surface.md
---
# prune max tool calls per turn

## Objective

Remove the dead `maxToolCallsPerTurn` configuration surface from vision-proxy. It is parsed and validated but never enforced, since turn-level tool limits are managed by the parent agent harness (Claude Code, Codex, Pi).

## Scope

- `src/core.ts` - remove `maxToolCallsPerTurn` from `VisionConfig`, `DEFAULT_CONFIG`, `CONFIG_KEYS`, `CONFIG_NUMERIC_KEYS`, `EnvOverrides`, and the exported `maxToolCallsPerTurn()` helper.
- `src/config.ts` - remove any related wiring if present.
- `src/core.test.ts` and `src/config.test.ts` - remove associated tests.

## Tools / MCP / Skills

- `node --test` for unit tests.
- `fallow dead-code --format json --quiet` to confirm the surface is gone.
- `fallow audit` for change review.
- `git worktree` / `wt` for isolation.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| Tests pass | `npm test` | green |
| Type check | `npm run typecheck` | clean |
| Dead code check | `fallow dead-code --format json --quiet` | no `maxToolCallsPerTurn` surface |
| Config still works | `vp config get` / `vp config set` | unaffected |

## Status

- [ ] Remove `maxToolCallsPerTurn` from `VisionConfig`, `DEFAULT_CONFIG`, `CONFIG_KEYS`, `CONFIG_NUMERIC_KEYS`.
- [ ] Remove `VP_MAX_TOOL_CALLS_PER_TURN` env override resolution.
- [ ] Remove exported `maxToolCallsPerTurn()` helper.
- [ ] Remove associated tests.
- [ ] Run `npm test`, `npm run typecheck`, `fallow dead-code`, `fallow audit`.
- [ ] Open PR and merge to `main`.

## Open questions

- None. This is a straightforward dead-code removal tracked in `../bugs/backend-core-dead-max-tool-calls-per-turn-surface.md`.
