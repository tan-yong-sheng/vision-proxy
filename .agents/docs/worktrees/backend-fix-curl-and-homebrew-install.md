---
type: worktree
title: fix curl and homebrew install
description: Fix curl and Homebrew installation for the tan-yong-sheng/vision-proxy fork so both documented install paths work end-to-end.
area: backend
tags: []
status: active
created: "2026-08-17"
updated: "2026-08-18"
stale_after: "2026-08-31"
branch: feat/fix-curl-homebrew-install
pr_strategy: separate
related: [../plans/backend-fix-curl-and-homebrew-install.md]
---
# fix curl and homebrew install

## Objective

Fix curl and Homebrew installation for the tan-yong-sheng/vision-proxy fork so both documented install paths work end-to-end.

## Scope

See plan deliverables.

## Tasks

- [x] Implement fix curl and homebrew install per plan

## Verification

- `npm test`: 152 pass / 0 fail on feature branch.
- `npm run typecheck`: pass.
- `fallow audit --gate-marker agent`: pass.

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [x] Landed on feature branch (ready for PR/merge)

## QA notes

Curl installer and automated Homebrew `sha256` fix verified locally.
A follow-up commit (`e8241de`) fixed the release-tarball launcher to resolve the `~/.local/bin/vp` symlink before locating `dist/cli.js`.
This branch is a separate PR against `dev`.
PR: https://github.com/tan-yong-sheng/vision-proxy/pull/11.
