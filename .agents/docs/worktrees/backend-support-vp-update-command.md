---
type: worktree
title: support vp update command
description: Implement vp update command for self-updating curl-installed vision-proxy binaries.
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

Add a `vp update` command to `vision-proxy` that allows self-updating curl-installed CLI binaries in `~/.local/share/vision-proxy`, while detecting Homebrew, npm, and source builds to guide users with package-manager-specific update instructions.

## Scope

- Create `src/commands/update.ts`:
  - `detectInstallMethod(binPath: string)`: detects `curl`, `homebrew`, `npm`, or `source`.
  - `fetchLatestVersion()`: extracts latest release tag from GitHub release redirect header.
  - `runUpdate(options: UpdateOptions)`: executes self-update via `install.sh` or prints guide messages for external package managers.
- Update `src/cli.ts`:
  - Wire `update` subcommand into `main(argv)`.
  - Add `vp update` usage and subcommand help into `HELP` and `HELP_INDEX`.
  - Parse `--check` (`-c`), `--version <tag>`, and `--force` (`-f`) flags.
- Create `src/commands/update.test.ts`:
  - Unit tests for installation method detection across various paths.
  - Unit tests for version comparison and GitHub release header resolution.
  - Mock integration tests for update command dispatch and dry-run/check flags.
- Update documentation:
  - Add `vp update` to `README.md` under installation / updating section.
  - Add `vp update` to `docs/QUICKSTART.md`.

## Verification

- `npm test` passes with all new update command tests.
- `npm run typecheck` passes with zero errors.
- `fallow audit --format json --quiet --explain --gate-marker agent` passes.
- `biome check` passes cleanly.
- `vp update --help` renders complete help and flag documentation.

## Status

- [ ] Branch created from `main`
- [ ] Implementation complete
- [ ] Local checks pass (`npm test`, `npm run typecheck`, `biome check`, `fallow audit`)
- [ ] PR opened against `main`
- [ ] `/review-gate` complete

