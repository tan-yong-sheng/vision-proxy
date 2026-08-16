---
type: plan
title: OSV-Scanner CI integration
description: Add OSV-Scanner to vision-proxy CI for dependency vulnerability scanning on PRs and scheduled full scans.
area: backend
tags: [security, ci, osv-scanner]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-10-15"
related:
  - ../research/backend-osv-scanner-adoption-for-vision-proxy-ci.md
---
# OSV-Scanner CI integration

## Goal capsule

Add OSV-Scanner to `vision-proxy` CI so every pull request is checked for newly introduced dependency vulnerabilities and the default branch is scanned on a recurring schedule.

## Current state

- CI already runs lint, typecheck, tests, and BetterLeaks secret scanning.
- The repo uses `pnpm` and has a `pnpm-lock.yaml` lockfile.
- There is no dependency vulnerability scanning today.
- Trivy was considered but rejected for this repo after research showed multiple 2026 supply-chain compromises.
See `../research/backend-osv-scanner-adoption-for-vision-proxy-ci.md`.

## Target state

- A PR workflow runs OSV-Scanner and reports only newly introduced vulnerabilities.
- A scheduled workflow runs a full scan and uploads SARIF results to the GitHub Security tab.
- Dependabot alerts and dependency-review are enabled as complementary controls.
- The project has an `osv-scanner.toml` ignore policy for accepted risks.

## Key technical decisions

| ID | Decision | Rationale |
| --- | --- | --- |
| D1 | Use the official Google reusable workflows | Less custom code to maintain and well documented |
| D2 | Pin the reusable workflow reference to a SHA | Reduces supply-chain risk from tag repointing |
| D3 | Keep existing BetterLeaks secret scanning | OSV-Scanner does not scan secrets |
| D4 | Add `osv-scanner.toml` from the start | Prevents the scheduled scan from staying red due to inherited noise |
| D5 | Run scans with `pnpm-lock.yaml` only | Faster and avoids false positives from uninstalled dev dependencies |

## Deliverables

1. `.github/workflows/osv-scanner-pr.yml` - PR diff scanning.
2. `.github/workflows/osv-scanner-scheduled.yml` - scheduled full scanning with SARIF upload.
3. `osv-scanner.toml` - ignore policy for accepted/tracked risks.
4. Updated `README.md` or `AGENTS.md` note describing the security checks.
5. QA dossier verifying that the PR workflow catches a known test vulnerability and that the scheduled workflow uploads SARIF successfully.

## Worktree Strategy

Single worktree.

- Branch: `feat/backend-osv-scanner-ci`
- Objective: implement and verify the OSV-Scanner workflows and policy file.
- Tasks:
  1. Add PR workflow pinned to the SHA of `google/osv-scanner-action@v2.5.0`.
  2. Add scheduled workflow with SARIF upload.
  3. Add a minimal `osv-scanner.toml`.
  4. Enable Dependabot alerts and dependency-review in repository settings.
  5. Run the workflows against a test branch with a deliberately vulnerable dependency and confirm failure/alert behavior.
- Verification: QA dossier in `.agents/docs/qa/` referencing the test run and SARIF upload.

## Tools / MCP / Skills

- `agents-docs` for doc lifecycle.
- `tdd` workflow for workflow verification.
- GitHub Actions and OSV-Scanner reusable workflows.
- BetterLeaks (existing) for secret scanning.

## Risks

| Risk | Mitigation |
| --- | --- |
| Reusable workflow tag is repointed | Pin to SHA and verify in code review |
| Scheduled scan finds many inherited CVEs | Seed `osv-scanner.toml` with accepted risks and triage findings before merging |
| PR scan false positives | Use the diff-only reusable workflow; do not block merge on inherited findings |
| Workflow permissions too broad | Grant only `contents: read`, `actions: read`, and `security-events: write` |

## Related

- `../research/backend-osv-scanner-adoption-for-vision-proxy-ci.md`
