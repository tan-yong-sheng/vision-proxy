---
type: worktree
title: Pi extension installer
description: Add vp integration install pi that writes a Pi extension file registering an analyze_image tool.
area: backend
tags: [post-migration, pi, extension]
status: merged
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-08-29"
related: [../plans/backend-vision-proxy-post-migration-feature-set.md]
---
# Pi extension installer

## Branch

- **Worktree branch**: `vp-pi-extension`
- **Base branch**: `configurable-analyze-image-limit`
- **Depends on**: none

## Objective

Implement `vp integration install pi` (plus `show` and `uninstall`) so Pi users get an `analyze_image` tool that shells out to `vp analyze`.

## Scope

`src/commands/integration.ts`, `src/cli.ts`, `src/pi-extension.ts` (template), `src/commands/integration.test.ts`

## Tasks

- [x] Add `src/commands/integration.ts` with `install`, `show`, and `uninstall` subcommands for `pi`.
- [x] Embed or generate a Pi extension TypeScript template that registers an `analyze_image` tool.
- [x] Wire `vp integration <install|show|uninstall> <agent>` into `src/cli.ts`.
- [x] Write the generated extension to `~/.pi/agent/extensions/vision-proxy.ts` on install.
- [x] Add unit tests covering install/show/uninstall paths (using temp dirs).

## Verification

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
fallow audit
```

## Dispatch

- **Run**: `run_82079408b671`
- **Task**: `task_00a9556db926`
- **Dispatch**: `ctx_c4c664769af1`
- **Terminal**: `term_6d8c879e-1e52-4feb-b813-49368da52c5f`
- **Worktree path**: `/home/tys203831/Documents/Coding/vision-proxy/.worktrees/vp-pi-extension`

## Status

- [x] Worktree created
- [x] Implementation complete (commit `0cd7262`)
- [x] Tests pass (77 tests)
- [ ] Merged into integration branch
