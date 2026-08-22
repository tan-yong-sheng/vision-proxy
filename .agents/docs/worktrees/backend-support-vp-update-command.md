---
type: worktree
title: support vp update command
description: Implement vp update command, background auto-update notification, and update README quickstart.
area: backend
tags: []
status: active
created: "2026-08-22"
updated: "2026-08-22"
stale_after: "2026-09-05"
related:
  - ../plans/backend-support-vp-update-command.md
branch: feat/support-vp-update-command
pr_strategy: separate
---
# support vp update command

## Objective

Add background auto-update notification check (via `~/.vision-proxy/update-check.json`) on CLI invocations, and update `README.md` and `docs/QUICKSTART.md` to showcase persistent JSON configuration in `~/.vision-proxy/config.json`.

## Scope

- In `src/commands/update.ts`:
  - `loadUpdateCache()` / `saveUpdateCache()`: manage `~/.vision-proxy/update-check.json` (schema: `{ checked_at, latest_version }`).
  - `checkAutoUpdateNotification()`: read cache, compare versions, print non-intrusive stderr banner if `latest_version > current_version`.
  - `spawnBackgroundUpdateCheck()`: spawn detached `node dist/cli.js update --background-check` (`stdio: "ignore"`, `child.unref()`) when cache is older than 24h.
  - `runBackgroundCheck()`: worker logic for `--background-check` to query GitHub release and write cache.
  - Guard against notification in `vp hook`, `--json`, `CI=1`, `VP_NO_UPDATE_NOTIFIER=1`, or `!process.stderr.isTTY`.
- In `src/cli.ts`:
  - Trigger `checkAutoUpdateNotification()` during `main()` startup (outside of `hook` and `--json`).
  - Handle hidden/internal `--background-check` flag in `update` command.
- In `src/commands/update.test.ts`:
  - Unit tests for cache expiration, notice banner formatting, suppression flags, and background worker spawn.
- In `README.md` and `docs/QUICKSTART.md`:
  - Update quickstart section with `~/.vision-proxy/config.json` JSON snippet and CLI configuration commands.
  - Document `VP_NO_UPDATE_NOTIFIER` in configuration docs.

## Verification

- `npm test` passes with all new notification and background check tests.
- `npm run typecheck` passes with zero errors.
- `fallow audit --format json --quiet --explain --gate-marker agent` passes.
- `biome check` passes cleanly.
- `vp hook` output is verified clean and never contains update banners.

## Status

- [x] Branch created from `main`
- [ ] Implementation complete
- [ ] Local checks pass (`npm test`, `npm run typecheck`, `biome check`, `fallow audit`)
- [ ] Merged into `main`
- [ ] `/review-gate` complete


