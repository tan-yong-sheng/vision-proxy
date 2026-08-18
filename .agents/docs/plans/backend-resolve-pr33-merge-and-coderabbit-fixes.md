---
type: plan
title: Resolve PR #33 merge conflicts and CodeRabbit blockers
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-09-17"
related: []
---
# Resolve PR #33 merge conflicts and CodeRabbit blockers

## Goal capsule

Make PR #33 (`dev` → `main`) mergeable by resolving its conflicts and addressing the actionable CodeRabbit review comments that represent real regressions or security issues.

## Current state

- PR #33 is `CONFLICTING`/`DIRTY`.
- CodeRabbit posted 12 actionable comments.
- Critical issues:
  - `VP_ALLOW_DRIVES=0` incorrectly rejects POSIX absolute paths.
  - `sanitize()` merges `fileConfig` before `envOverrides`, breaking env-var precedence.
  - API key persisted in config is written without `0o600` permissions and is echoed back in `vp config set apiKey` output.
- Secondary issues:
  - Archived doc links point to stale `plans/` paths.
  - README/SETUP/CONFIG docs omit or misdescribe `apiKey` support.
  - `biome.json` schema URL mismatches installed version.
  - Missing `@tags` JSDoc on exported helpers.

## Target state

- A clean `dev` → `main` merge commit with conflicts resolved.
- The three critical issues above fixed and covered by tests where applicable.
- Docs updated to match current behavior.
- `/review-gate` passes.

## Key technical decisions

- Resolve conflicts by preferring the current `dev` implementation; the `main` merge-preview commits are superseded by the cleaned-up `dev` history.
- Keep fixes minimal and targeted so the PR remains reviewable.
- Do not change env-var names or config surface.

## Deliverables

- `qa/dev-main-merge` branch with the reconciled state.
- Updated PR #33 pointing at the reconciled branch.
- Merged to `main` and `dev` fast-forwarded.

## Worktree Strategy

### `qa/dev-main-merge` — Reconcile `dev` and `main` for PR #33

- **Branch:** `qa/dev-main-merge`
- **Objective:** Merge `main` into a preview branch, resolve conflicts, fix CodeRabbit blockers, and make PR #33 mergeable.
- **Scope & Files:** `src/core.ts`, `src/commands/config.ts`, `src/commands/config.test.ts`, `src/commands/hook.ts`, `src/provider.ts`, `src/commands/provider.ts`, `src/cli.ts`, `biome.json`, `README.md`, `docs/CONFIG.md`, `docs/SETUP.md`, `.agents/docs/archive/*.md`.
- **Depends On:** none
- **Verification Criteria:** `npm test`, `npm run typecheck`, `/review-gate`.
