---
type: coverage
title: "QA: combined PreToolUse Read hook PR"
description: "QA: combined PreToolUse Read hook PR - one-line summary."
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-11-16"
related:
  - ../worktrees/backend-phase-1-prototype-spike.md
  - ../worktrees/backend-phase-2-full-implementation.md
  - ../plans/backend-add-pretooluse-read-hook.md
---
# QA: combined PreToolUse Read hook PR

## Surface covered

Merge-preview worktree `qa/vp-hook` combining `feat/add-pretooluse-read-hook` (prototype) and `feat/add-pretooluse-read-hook-impl` (production) for a single PR to `dev`.

## Resolution intent

Validate the combined hook PR before pushing.
The combined state is the review surface because both branches share the same feature (PreToolUse Read hook) and must integrate cleanly.

## Matrix

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` in `qa/vp-hook` | pass | 157 pass / 0 fail |
| `npm run typecheck` in `qa/vp-hook` | pass | no errors |
| `fallow audit --gate-marker agent` in `qa/vp-hook` | pass | verdict pass, gate new-only |
| `/review-gate` on `qa/vp-hook` attempt 1 | failed | `no-mistakes axi run` step `review` failed with `agent review: pi output parse: invalid character 'L' looking for beginning of value` (internal parser error, no actionable code finding) |
| `/review-gate` on `qa/vp-hook` attempt 2 | failed | `no-mistakes axi run` step `review` failed with `pi reported error: The service is temporarily unavailable` |
| `/fallow-review` on `qa/vp-hook` | pass | no consequential structural decisions; 2 advisory weakening signals |
| PR opened | pass | https://github.com/tan-yong-sheng/vision-proxy/pull/12 |
| Branch pushed | pass | `feat/add-pretooluse-read-hook-pr` |
| PreToolUse deny change verification | pass | commit `3104038`: `npm test` 157/0, `npm run typecheck` pass, `fallow audit` pass |
| PreToolUse "do not retry" instruction | pass | commit `ebac8ff`: `npm test` 157/0, `npm run typecheck` pass, `fallow audit` pass |
| UserPromptSubmit instruction | pass | commit `eb2ab5b`: `npm test` 157/0, `npm run typecheck` pass, `fallow audit` pass |
| Branch pushed with UserPromptSubmit instruction | pass | `feat/add-pretooluse-read-hook-pr` now at `eb2ab5b` |

## Notes

Both review-gate attempts failed inside no-mistakes, not because of repository findings:

1. Attempt 1: agent reviewer tried to parse a Pi response that began with prose (`"Let me check a few more details..."`) instead of JSON.
2. Attempt 2: upstream Pi service returned `The service is temporarily unavailable`.

Local checks (test, typecheck, fallow audit) all pass.
Used `/fallow-review` as a fallback; it found no blocking structural issues.
The PR branch `feat/add-pretooluse-read-hook-pr` was created from the validated `qa/vp-hook` merge-preview state and pushed as #12.
A follow-up commit (`3104038`) changed PreToolUse Read of an image from `allow` to `deny` so the agent skips the native Read and receives the vision-proxy description as `additionalContext`.
Commit `ebac8ff` further prepends an instruction to the injected context telling the agent that the image was already routed through vision-proxy and not to retry Read on image files.
Commit `eb2ab5b` applies the same instruction prefix to `UserPromptSubmit` so both hook paths consistently tell the agent not to call Read on image files.

## Retirement criteria

- `/review-gate` reaches a final outcome.
- Findings are addressed or recorded as deferred bugs.
- Combined PR is pushed.
