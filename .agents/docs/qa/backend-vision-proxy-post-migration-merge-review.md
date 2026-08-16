---
type: coverage
title: vision-proxy post-migration merge review
description: QA dossier for the combined review of lazy cache pruning, Pi extension installer, and keyring credential storage.
area: backend
tags: [post-migration, merge-preview, no-mistakes]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-11-13"
related:
  - ../archive/research-backend-vision-proxy-review-run-lessons.md
  - ../bugs/backend-pi-extension-undeclared-typebox-dependency.md
  - ../archive/bug-backend-core-dead-max-tool-calls-per-turn-surface.md
---
# vision-proxy post-migration merge review

## Surface covered

Combined state of three parallel feature branches merged into the disposable `preview-merge` (formerly `int-merge`) worktree:

- `vp-lazy-cache-prune` — `cacheMaxAgeDays` config/env + lazy pruning on `cacheGet`
- `vp-pi-extension` — `vp integration install pi` and Pi extension template
- `vp-keyring-storage` — optional `@napi-rs/keyring` API key storage

## Resolution intent

Run `/review-gate` (no-mistakes `axi run`) on the merge-preview worktree before merging into `configurable-analyze-image-limit`.
This is a local-only review (`--skip push,pr,ci`) because preview worktrees are disposable.

## Matrix

| branch | merged into preview-merge | commit | local checks |
|---|---|---|---|
| `vp-lazy-cache-prune` | yes | `308885a` | pnpm install / build / test / typecheck / fallow audit pass |
| `vp-pi-extension` | yes | `3a4424e` | pnpm install / build / test / typecheck / fallow audit pass |
| `vp-keyring-storage` | yes | `01fed25` | pnpm install / build / test / typecheck / fallow audit pass |

## Review Findings & Escalations

- **W1 (Undeclared `typebox` runtime dependency):** Tracked in [../bugs/backend-pi-extension-undeclared-typebox-dependency.md](../bugs/backend-pi-extension-undeclared-typebox-dependency.md). Recommended resolution is Option A1 (inline JSON Schema).
- **W2 (Dead `maxToolCallsPerTurn` surface):** Tracked in [../archive/bug-backend-core-dead-max-tool-calls-per-turn-surface.md](../archive/bug-backend-core-dead-max-tool-calls-per-turn-surface.md). Recommended resolution is Option B1 (prune dead configuration surface).
- **Operational lessons & post-mortem:** Documented in [../archive/research-backend-vision-proxy-review-run-lessons.md](../archive/research-backend-vision-proxy-review-run-lessons.md).

## Retirement criteria

- no-mistakes review reaches a terminal outcome
- Findings are resolved or escalated
- `preview-merge` is merged into `configurable-analyze-image-limit` and stale worktrees (`int-merge`, `preview-merge`) are removed

