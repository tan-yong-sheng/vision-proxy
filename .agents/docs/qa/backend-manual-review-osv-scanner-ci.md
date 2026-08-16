---
type: coverage
title: "Manual review: OSV-Scanner CI integration"
description: "Manual review of feat/backend-osv-scanner-ci branch after no-mistakes agent parser failures."
area: backend
tags: [review, security, ci, osv-scanner]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-11-14"
related:
  - ../../worktrees/backend-osv-scanner-ci-integration.md
---
# Manual review: OSV-Scanner CI integration

## Surface covered

- `.github/workflows/osv-scanner-pr.yml` - PR diff scan pinned to `google/osv-scanner-action@v2.5.0` SHA
- `.github/workflows/osv-scanner-scheduled.yml` - weekly full scan with SARIF upload
- `osv-scanner.toml` - ignore policy for accepted risks
- `README.md` / `AGENTS.md` - security check documentation
- `.gitignore` - `tmp-verify/` entry

## Resolution intent

Automated `no-mistakes` review failed twice with agent output parser errors during the review/fixing step. I aborted the run, recovered the branch, and completed a manual review of the workflow files and policy.

## Matrix

| Check | Command | Result |
|---|---|---|
| Build | `pnpm run build` | pass |
| Tests | `pnpm test` | 138 + 3 pass |
| Typecheck | `pnpm run typecheck` | pass |
| Fallow audit | `fallow audit --format json --quiet --explain --gate-marker agent` | pass |

## Findings

No findings. The workflow permissions are scoped (`contents: read`, `actions: read`, `security-events: write`), actions are pinned to SHA, and the ignore policy documents the accepted `image-size` CVE with rationale.

## Retirement criteria

- Branch is rebased onto `main` after PR #6 lands.
- Workflows are verified with `act` after rebase.
- PR is opened and merged.
