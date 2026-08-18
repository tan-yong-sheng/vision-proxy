---
type: coverage
title: "QA: curl and Homebrew install fix PR"
description: "QA: curl and Homebrew install fix PR - one-line summary."
area: backend
tags: []
status: pending
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-11-16"
related:
  - ../worktrees/backend-fix-curl-and-homebrew-install.md
  - ../plans/backend-fix-curl-and-homebrew-install.md
  - ../bugs/backend-curl-and-homebrew-install-fail.md
---
# QA: curl and Homebrew install fix PR

## Surface covered

Feature branch `feat/fix-curl-homebrew-install` as a separate PR to `dev`.

## Resolution intent

Validate the curl/Homebrew installer fix before pushing.
This PR is independent of the hook work, so it is reviewed on its own feature branch (`pr_strategy: separate`).

## Matrix

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` on `feat/fix-curl-homebrew-install` | pass | 152 pass / 0 fail |
| `npm run typecheck` on `feat/fix-curl-homebrew-install` | pass | no errors |
| `fallow audit --gate-marker agent` on `feat/fix-curl-homebrew-install` | pass | verdict pass, gate new-only |
| `/review-gate` on `feat/fix-curl-homebrew-install` | failed | `no-mistakes axi run` step `review` failed with `pi reported error: The service is temporarily unavailable` |

## Notes

The review-gate attempt failed inside no-mistakes because the upstream Pi service returned `The service is temporarily unavailable`.
Local checks (test, typecheck, fallow audit) all pass.
The next step is either a retry when the service is stable, or switching to `/fallow-review` as a fallback.

## Retirement criteria

- `/review-gate` reaches a final outcome.
- Findings are addressed or recorded as deferred bugs.
- PR is pushed.
