---
type: worktree
title: OSV-Scanner CI integration
description: Add OSV-Scanner to vision-proxy CI for dependency vulnerability scanning on PRs and scheduled full scans.
area: backend
tags: [security, ci, osv-scanner]
status: review
branch: feat/backend-osv-scanner-ci
base: main
stack_position: 1
stack_batch: vp-security-tooling
created: "2026-08-16"
updated: "2026-08-16"
commits_verified:
  - 4f6f5b7
merge_preview_verified: ""
stale_after: "2026-08-30"
related: [../plans/backend-osv-scanner-ci-integration.md]
---
# OSV-Scanner CI integration

## Objective

Add OSV-Scanner to vision-proxy CI for dependency vulnerability scanning on PRs and scheduled full scans.

## Scope

See plan deliverables.

## Tasks

- [ ] Implement OSV-Scanner CI integration per plan

## Verification

npm test

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [x] Landed on feature branch
- [ ] Rebase onto `main` after PR #6 lands.
- [ ] Run `/review-gate`.
- [ ] Open PR and merge to `main`.
