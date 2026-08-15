---
type: plan
title: Unify hook and integration commands
description: "Replace `vp hook` with a single `vp integration install <agent>` command that writes hooks for Claude Code/Codex and an extension for Pi."
area: backend
tags: [cli, hook, integration, refactor]
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ../research/backend-pi-hook-versus-integration-support.md
  - ./backend-simplify-cli-surface-drop-vp-provider-add-and-unify-vp-hook-into-vp-integration.md
superseded_by: ./backend-simplify-cli-surface-drop-vp-provider-add-and-unify-vp-hook-into-vp-integration.md
---
# Unify hook and integration commands

## Goal capsule

Delete the `vp hook` subcommand and move all agent install paths under `vp integration install <agent>`:
- `vp integration install claude` — installs the UserPromptSubmit hook for Claude Code.
- `vp integration install codex` — installs the UserPromptSubmit hook for Codex.
- `vp integration install pi` — installs the Pi extension.

This matches herdr's `herdr integration install <target>` design and gives users one consistent command regardless of the underlying agent mechanism.

## Current state

- `vp hook install|show|list|uninstall <agent>` supports `claude-code` and `codex`.
- `vp integration install|show|uninstall <agent>` supports `pi`.
- Both write to agent config directories:
  - Claude Code: `~/.claude/settings.json` + shim file in `~/.claude/hooks/`.
  - Codex: `~/.codex/config.toml` + shim file in `~/.codex/`.
  - Pi: `~/.pi/agent/extensions/vision-proxy.ts`.
- `src/cli.ts` exposes two separate subcommands.
- Tests, README, AGENTS, and CLI help all document both commands.

## Target state

- Remove `vp hook` from `src/cli.ts`.
- Merge `src/commands/hook.ts` logic into `src/commands/integration.ts`.
- `vp integration` becomes the single command that knows how to install the right artifact per agent:
  - `claude` and `codex` agents use hook files and config edits.
  - `pi` agent uses an extension file.
- Add `vp integration list` to show which agents are installed, replacing `vp hook list`.
- Keep `vp integration show` and `vp integration uninstall` working for all three agents.
- Update docs, tests, README, AGENTS, and CLI help.

## Key technical decisions

1. **Agent mechanism is hidden from the user.**
   `vp integration install <agent>` picks hook or extension internally based on the agent spec.

2. **Keep the existing shim/extension source files.**
   `src/shims/*.mjs` and `src/pi-extension.ts` do not change; only the installer dispatcher changes.

3. **Agent names.**
   Use the same short names as herdr: `claude`, `codex`, `pi`.
   Map the legacy `claude-code` name to `claude` for backward compatibility during a deprecation window, or remove it.

4. **Backward compatibility.**
   - Option A: hard delete `vp hook` (clean break, pre-1.0 acceptable).
   - Option B: keep `vp hook` as a hidden alias to `vp integration` for one release, then delete.
   The user asked to delete it, so Option A is preferred unless we want a deprecation alias.

5. **File locations.**
   - Hook install logic moves from `src/commands/hook.ts` into `src/commands/integration.ts`.
   - `src/cli.ts` drops the `hook` branch and adds `list` to `integration`.

## Deliverables

| # | Deliverable | File changes |
|---|---|---|
| 1 | Move hook specs into integration module | `src/commands/integration.ts`, `src/commands/hook.ts` deleted |
| 2 | Update CLI wiring | `src/cli.ts` |
| 3 | Move and update tests | `src/commands/integration.test.ts`, `src/commands/hook.test.ts` deleted |
| 4 | Update docs and help | `README.md`, `AGENTS.md`, `src/cli.ts` help text |

## Worktree Strategy

This is a single refactor worktree because the changes are tightly coupled across CLI wiring, installer logic, and tests.

| worktree | branch | base | scope | verification |
|---|---|---|---|---|
| `vp-unify-integration` | `vp-unify-integration` | `configurable-analyze-image-limit` | Merge hook and integration commands | `pnpm test && pnpm run typecheck && fallow audit` |

## Tools / MCP / Skills

- `agents-docs` for plan and worktree tracking.
- `review-gate` before merging into `configurable-analyze-image-limit`.
- Native tools: `git`, `wt`, `pnpm`, `fallow`, `no-mistakes`.

## Risks

- **Breaking change.** Users who already ran `vp hook install` will need to use `vp integration install` after this lands.
- **Test churn.** The hook tests must be merged into the integration tests.
- **Doc churn.** README and AGENTS mention both commands.
- **Merge conflicts.** If the feature branches (`vp-lazy-cache-prune`, `vp-pi-extension`, `vp-keyring-storage`) are merged first, this refactor must be rebased on top.
