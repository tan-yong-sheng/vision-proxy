---
type: plan
title: fix curl and homebrew install
description: Fix curl and Homebrew installation for the tan-yong-sheng/vision-proxy fork so both documented install paths work end-to-end.
area: backend
tags: []
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-10-15"
entry_point: true
related:
  - ../research/backend-curl-and-homebrew-install-failure-on-tan-yong-sheng-fork.md
  - ../bugs/backend-curl-and-homebrew-install-fail.md
  - https://github.com/tan-yong-sheng/vision-proxy
---
# fix curl and homebrew install

## Goal capsule

Make both documented install paths for the tan-yong-sheng/vision-proxy fork work end-to-end: Homebrew installs without checksum errors, and the curl installer succeeds on a clean machine and leaves `vp` runnable on PATH.

## Current state

- The Homebrew formula ships with placeholder `sha256` values and is explicitly documented as not installable yet.
- The curl installer depends on `jq` and a SHA-256 tool, does not verify `~/.local/bin` is on PATH, and fails cryptically if the GitHub release asset is missing.
- Both issues are recorded in ../bugs/backend-curl-and-homebrew-install-fail.md and analyzed in ../research/backend-curl-and-homebrew-install-failure-on-tan-yong-sheng-fork.md.

## Target state

1. `Formula/vision-proxy.rb` contains real per-arch `sha256` values derived from the release's `sha256sum.txt`.
2. `scripts/install.sh` produces actionable error messages when dependencies are missing.
3. The curl installer either removes the `jq` dependency or tells the user exactly how to install it.
4. After a successful curl install, the user is told explicitly how to add `~/.local/bin` to PATH, or the installer offers to append it to the shell profile.
5. CI verifies the install script against a clean environment.

## Key technical decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Backfill Homebrew sha256 from the release's `sha256sum.txt` rather than hard-coding hashes | Keeps the formula in sync with the actual release artifacts; matches the README's stated workflow |
| D2 | Keep the formula inside the main repo (`Formula/vision-proxy.rb`) | The fork already uses this tap-in-repo pattern; moving it would break existing `brew tap` commands |
| D3 | Make `install.sh` print a dependency checklist before attempting the install | Fails fast with actionable guidance instead of mid-script errors |
| D4 | Do not auto-mutate the user's shell profile by default; print the exact export line and optionally append with a flag | Avoids surprising side effects; power users can opt in with `--add-to-path` |

## Tools / MCP / Skills

- Native: bash, read, edit
- Skills: agents-docs

## Deliverables

- Updated `Formula/vision-proxy.rb` with real sha256 values.
- Updated `scripts/install.sh` with dependency checks, clearer errors, and PATH guidance.
- CI workflow that runs the curl installer on a minimal runner.
- Updated README install section if behavior changes.

## Worktree Strategy

Single worktree. Branch: `feat/fix-curl-homebrew-install`.

Tasks:

- [ ] Update `Formula/vision-proxy.rb` to read sha256 values from the release's `sha256sum.txt` workflow.
- [ ] Add dependency checks and actionable messages to `scripts/install.sh`.
- [ ] Add `--add-to-path` flag to append `~/.local/bin` to the detected shell profile.
- [ ] Add CI job that exercises the curl installer on ubuntu-latest + macos-latest without `jq` pre-installed.
- [ ] Verify `brew install` works after a release is published.

## Risks / open questions

- [ ] Does the fork's CI publish all four OS/arch tarballs plus `sha256sum.txt`? Verify before changing the formula.
- [ ] Should the installer bundle a tiny POSIX JSON parser to remove the `jq` dependency entirely?
- [ ] Which shell profiles should `--add-to-path` support (`.bashrc`, `.zshrc`, `.config/fish/config.fish`)?
