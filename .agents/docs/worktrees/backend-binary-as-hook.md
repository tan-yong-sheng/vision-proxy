---
type: worktree
title: Worktree
description: "Replace shim-based hooks with `vp analyze --hook` binary-as-hook integration."
area: backend
tags:
  - cli
  - hooks
  - claude-code
  - codex
  - pretooluse
  - integration
  - binary-as-hook
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-08-30"
related: [../plans/backend-binary-as-hook-vision-proxy-integration.md]
depends_on: ["PR #6 merge"]
---
# Worktree

## Objective

Replace shim-based hooks with `vp analyze --hook` binary-as-hook integration.

## Scope

`src/commands/analyze.ts`, `src/commands/integration.ts`, `src/cli.ts`, `src/shims/`, `scripts/copy-shims.mjs`, `package.json`, `src/commands/integration.test.ts`, `README.md`, `AGENTS.md`.

## Tasks

- [ ] Implementation complete

## Verification

`pnpm install && pnpm run build && pnpm test && pnpm run typecheck && fallow audit`

## Status

- [ ] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
