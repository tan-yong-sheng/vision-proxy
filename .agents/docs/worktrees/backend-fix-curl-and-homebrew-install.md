---
type: worktree
title: fix curl and homebrew install
description: Fix curl and Homebrew installation for the tan-yong-sheng/vision-proxy fork so both documented install paths work end-to-end.
area: backend
tags: []
status: active
created: "2026-08-17"
updated: "2026-08-17"
stale_after: "2026-08-31"
related: [../plans/backend-fix-curl-and-homebrew-install.md]
---
# fix curl and homebrew install

## Objective

Fix curl and Homebrew installation for the tan-yong-sheng/vision-proxy fork so both documented install paths work end-to-end.

## Scope

See plan deliverables.

## Tasks

- [x] Implement fix curl and homebrew install per plan

## Changes

- `scripts/install.sh`: dropped the `jq` dependency (now parses GitHub release
  JSON with POSIX awk), added early dependency checks with actionable guidance,
  added a `--add-to-path` flag that appends `~/.local/bin` to the detected shell
  profile, and improved error messages for missing assets / checksum mismatch.
- `Formula/vision-proxy.rb`: sha256 values are now documented as auto-filled at
  release time (no manual per-release edit needed).
- `.github/workflows/release.yml`: switched the build to pnpm (was incorrectly
  using npm), and added a step that backfills the four per-arch sha256 values
  from the generated `sha256sum.txt` and commits the updated formula to `main`.
- `.github/workflows/installer.yml` (new): exercises `scripts/install.sh`
  end-to-end on ubuntu-latest and macos-latest against a local release mock,
  with no `jq` installed, and verifies `vp` lands on PATH.
- `README.md`: updated the install section to drop the "formula not installable"
  note, document `--add-to-path`, and clarify the no-jq requirement.

## Verification

- `pnpm test` passes (152 tests).
- `scripts/install.sh` dry-run against a local mock release succeeds: resolves
  release, downloads, verifies checksum, symlinks `vp`, appends to `.bashrc`
  with `--add-to-path`, and `vp --version` works on PATH.
- Error paths verified: missing asset for the current arch exits with a clear
  message; `json_value`/`asset_url` awk handles both pretty and compact JSON.

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
