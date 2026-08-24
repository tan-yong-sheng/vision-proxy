---
type: plan
title: support vp update command
description: Add a vp update command to self-update curl-installed vision-proxy binaries, background auto-update notifications, and streamline provider quickstart in documentation.
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
Add non-blocking auto-update notification checks via `~/.vision-proxy/update-check.json` on CLI invocations, and streamline documentation quickstart to emphasize `~/.vision-proxy/config.json` with provider and apiKey settings.

## Current state

- `vp update` exists to manually update or check versions for curl installs.
- `vp` does not automatically check for new releases in the background or notify users when a new release is available.
- `README.md` quickstart previously showed temporary session environment variables (`export ANTHROPIC_API_KEY=...`) rather than persistent `~/.vision-proxy/config.json` configuration, causing friction when agents run hooks in isolated subshells.

## Target state

- **Auto-Update Notification**:
  - `~/.vision-proxy/update-check.json` persists `{ "checked_at": "<ISO-timestamp>", "latest_version": "<tag>" }`.
  - On CLI command startup, check `update-check.json` (<1ms local read).
  - If `latest_version > current_version`, print a non-intrusive notification banner to `stderr`:
    `A new version of vision-proxy is available: v0.1.2 (current: v0.1.1). Run 'vp update' to upgrade.`
  - If `update-check.json` is missing or older than 24 hours (86,400,000 ms), spawn a detached background check (`node dist/cli.js update --background-check`) with `child.unref()` and `stdio: "ignore"` to update the cache without blocking the active command.
  - Notification and background checking are suppressed when:
    - Running `vp hook` (or `process.env.VP_HOOK` / `isHookEvent`), ensuring agent prompt/tool hooks are never polluted.
    - `--json` flag is active.
    - Running in CI (`process.env.CI`).
    - `process.env.VP_NO_UPDATE_NOTIFIER=1` is set.
    - `!process.stderr.isTTY` (non-interactive pipes).
- **Documentation Quickstart**:
  - Update `README.md` and `docs/QUICKSTART.md` quickstart to showcase persistent JSON config in `~/.vision-proxy/config.json`:
    ```json
    {
      "provider": "google",
      "apiKey": "AIzaSy..."
    }
    ```
  - Alongside `vp config set provider google` and `vp config set apiKey ...` CLI alternatives.

## Key technical decisions

1. **Decouple notification checks from command execution**:
   Reading the local `update-check.json` happens synchronously on startup in `< 1ms`.
   Network queries only happen in detached background child processes, guaranteeing zero latency overhead for user commands.
2. **Strict hook isolation**:
   Agent hooks (`vp hook`) must receive clean stdout/stderr output.
   All update banners and background check spawns are strictly bypassed during hook execution.
3. **Cache path standard**:
   Store `update-check.json` inside `~/.vision-proxy/` (alongside `config.json` and `cache.json`), ensuring user-level isolation and easy clean up.

## Deliverables

| # | Deliverable | File(s) |
|---|---|---|
| 1 | Add cache reading, background check spawning, and notice banner to update module. | `src/commands/update.ts` |
| 2 | Connect auto-check hook into CLI startup and wire `--background-check` handler. | `src/cli.ts` |
| 3 | Add unit and integration tests for update cache TTL, banner rendering, suppression rules, and background spawn. | `src/commands/update.test.ts` |
| 4 | Update `README.md` and `docs/QUICKSTART.md` with JSON quickstart example and update notifier env var documentation. | `README.md`, `docs/QUICKSTART.md` |

## Tools / MCP / Skills

- **Agent Skills**: `agents-docs`, `worktrunk-orca-delegation`, `review-gate`
- **CLI Tools**: `node`, `bun`, `wt`, `orca`, `claude`

## Worktree Strategy

- Single feature worktree targeting `main` on branch `feat/support-vp-update-command`.

| Worktree doc | Branch | PR strategy | Depends on | Notes |
|---|---|---|---|---|
| [backend-support-vp-update-command](../worktrees/backend-support-vp-update-command.md) | `feat/support-vp-update-command` | separate | - | Targets main. |

## Risks

| Risk | Mitigation |
|---|---|
| Background check child process hangs | Spawn with `unref()` and `stdio: "ignore"`, with a short internal timeout on the HTTP probe. |
| Notification pollutes agent hook context | Explicitly guard `command === "hook"` and suppress notifier output when running hooks. |
| Stale or corrupt JSON cache file | Wrap cache read/parse in a try-catch block and fall back to empty cache. |
