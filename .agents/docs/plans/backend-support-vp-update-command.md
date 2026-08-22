---
type: plan
title: support vp update command
description: Add a vp update command to self-update curl-installed vision-proxy binaries and guide Homebrew/npm users to their respective package managers.
area: backend
tags: []
status: active
created: "2026-08-22"
updated: "2026-08-22"
stale_after: "2026-10-21"
related:
  - ../worktrees/backend-support-vp-update-command.md
---
# support vp update command

## Goal capsule

Introduce a `vp update` command that allows users installed via the curl installer (`~/.local/share/vision-proxy`) to self-update to the latest release or a pinned release tag with a single command.
For users installed via Homebrew, npm, or from source, `vp update` detects their install method and prints actionable instructions for updating through their respective package manager.

## Current state

- The curl installer (`scripts/install.sh`) installs release tarballs into `~/.local/share/vision-proxy/<version>` and symlinks `~/.local/bin/vp`.
- Updating requires re-running the long command: `curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh`.
- `vp` has no built-in `update` or `upgrade` subcommand in `src/cli.ts`.
- Users cannot check if a newer version of `vision-proxy` is available directly from the CLI.

## Target state

- `vp update` command is available with the following flags:
  - `vp update` - checks for the latest version and updates if a newer version is available.
  - `vp update --check` (`-c`) - checks whether an update is available without modifying any files.
  - `vp update --version <tag>` - installs a specific release tag (e.g. `v0.1.0`).
  - `vp update --force` (`-f`) - forces re-download and reinstallation even if already up to date.
- Installation source detection:
  - **Curl installer** (`~/.local/share/vision-proxy/...`): executes self-update via `install.sh`.
  - **Homebrew** (`/Cellar/` or `/homebrew/` in realpath): prints `vision-proxy was installed via Homebrew. Run 'brew upgrade vision-proxy' to update.`.
  - **npm** (`node_modules` in realpath): prints `vision-proxy was installed via npm. Run 'npm install -g vision-proxy' to update.`.
  - **Source checkout** (git clone / local dev): prints `vision-proxy is running from a local source build. Pull latest changes and run 'npm run build'.`.
- If already on the latest version (and neither `--force` nor `--version` is supplied), prints `vision-proxy is already up to date (vX.Y.Z)`.
- Updates `HELP` text and subcommand help in `src/cli.ts`.
- Updates documentation in `README.md` and `docs/QUICKSTART.md`.

## Key technical decisions

1. **Detect installation method via `fs.realpathSync(process.argv[1])`**:
   Inspecting the resolved realpath of the running CLI binary reliably distinguishes between `~/.local/share/vision-proxy/` (curl installer), Homebrew prefixes, npm global node_modules, and local checkouts.
2. **Delegate curl updates to `scripts/install.sh`**:
   Rather than re-implementing tarball download, OS/arch detection, SHA-256 verification, and symlink creation in TypeScript, `vp update` invokes `install.sh` with the appropriate arguments.
   This preserves a single source of truth for installer behavior and checksum verification.
3. **Probe latest release without GitHub API rate limits**:
   Like `install.sh`, fetch `https://github.com/tan-yong-sheng/vision-proxy/releases/latest` with redirect manual mode to extract the tag from the `Location` header, avoiding unauthenticated rate limits (60/hr) on GitHub API endpoints.
4. **POSIX-safe in-place update**:
   Because Node.js loads the running program into memory, updating the target directory in `~/.local/share/vision-proxy/<new-version>` and updating the symlink `~/.local/bin/vp` is safe and atomic on Linux and macOS.

## Deliverables

| # | Deliverable | File(s) |
|---|---|---|
| 1 | Create update command module with install detector, version checker, and installer runner. | `src/commands/update.ts` |
| 2 | Wire `update` subcommand, help index, and flag parsing into CLI entrypoint. | `src/cli.ts` |
| 3 | Add unit and integration tests for install detection, version parsing, and update flags. | `src/commands/update.test.ts` |
| 4 | Update user-facing documentation with `vp update` usage. | `README.md`, `docs/QUICKSTART.md` |

## Tools / MCP / Skills

- **Agent Skills**: `agents-docs`, `worktrunk-orca-delegation`, `review-gate`
- **CLI Tools**: `node`, `bun`, `wt`, `orca`, `claude`

## Worktree Strategy

- Single feature worktree targeting `main`.
- Independent command implementation with no shared contract breaks.

| Worktree doc | Branch | PR strategy | Depends on | Notes |
|---|---|---|---|---|
| [backend-support-vp-update-command](../worktrees/backend-support-vp-update-command.md) | `feat/support-vp-update-command` | separate | - | Targets main. |

## Risks

| Risk | Mitigation |
|---|---|
| User is offline or GitHub redirect fails | Fail gracefully with an informative error message explaining that the release check failed. |
| User installed via Homebrew or npm and runs `vp update` | Detect install source upfront and exit cleanly with the exact command for their package manager. |
| Incompatible Node.js version on remote update | `install.sh` performs Node >= 22 prerequisite check before touching symlinks. |
