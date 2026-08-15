---
type: plan
title: Simplify CLI surface - drop vp provider add and unify vp hook into vp integration
description: Remove the redundant `vp provider add` command, merge `vp hook` into `vp integration`, and add `vp integration status` with version markers so users can see whether their coding-agent integrations are installed and up to date.
area: backend
tags: [cli, hook, integration, provider, refactor, status, version]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ./backend-simplify-provider-setup-workflow-remove-redundant-vp-provider-add-make-config-se.md
  - ./backend-unify-hook-and-integration-commands.md
  - ../research/backend-pi-hook-versus-integration-support.md
---
# Simplify CLI surface - drop vp provider add and unify vp hook into vp integration

## Goal capsule

Two CLI-surface cleanups combined into one worktree because both touch `src/cli.ts` heavily and both reduce the visible command count.

1. Drop `vp provider add` — `vp config set provider` is the single registration point because the provider id already implies the env var (`OPENAI_API_KEY`).
2. Drop `vp hook` and merge hook installation into `vp integration` — `vp integration install <agent>` becomes the single install path for Claude Code, Codex, and Pi.
3. Add `vp integration status` — reports installed/current/outdated state for each agent by comparing embedded version markers against installed artifacts.

The combined branch lands as one PR so reviewers see the CLI surface in a single coherent diff.

## Current state

- `vp provider add <name>` writes an `apiKeyEnv` mapping that is already implied by the provider id. Redundant.
- `vp hook install|show|list|uninstall <agent>` exists for `claude-code` and `codex`.
- `vp integration install|show|uninstall <agent>` exists for `pi`.
- Two subcommands install agent artifacts; users must know which mechanism applies to which agent.
- `src/commands/provider.ts` has `providerAdd`, `src/commands/hook.ts` has the hook dispatcher, `src/commands/integration.ts` has the Pi dispatcher.
- README, AGENTS, and CLI help mention both `vp provider add` and `vp hook`.

## Target state

- `vp provider add` is removed.
- `vp hook` is removed.
- `vp integration install <agent>` handles `claude`, `codex`, and `pi` — selecting hook or extension internally.
- `vp integration list` replaces `vp hook list` (shows which agents are installed).
- `vp integration status` reports `not installed`, `current`, or `outdated` for each agent.
- `vp integration show` and `vp integration uninstall` work for all three agents.
- `src/commands/hook.ts` is deleted; its logic moves into `src/commands/integration.ts`.
- `src/commands/provider.ts` loses `providerAdd`.
- README, AGENTS, SETUP, and CLI help are updated.

## Key technical decisions

| ID | Decision | Rationale |
|---|---|---|
| K1 | Hard-delete `vp provider add` (no deprecation alias) | Pre-1.0; clean break avoids carrying unused code. |
| K2 | Hard-delete `vp hook` (no deprecation alias) | Same as K1. |
| K3 | Agent mechanism is hidden behind `vp integration install <agent>` | Matches herdr's `integration install <target>` pattern; one mental model. |
| K4 | Use short agent names (`claude`, `codex`, `pi`) | Aligns with herdr; `claude-code` is dropped entirely. |
| K5 | Move hook logic into `integration.ts`; keep `src/shims/*.mjs` and `src/pi-extension.ts` unchanged | The dispatch is the only thing changing; the artifacts are correct. |
| K6 | Add `vp integration list` | Replaces `vp hook list`; surfaces install state for all three agents. |
| K7 | Add `vp integration status` | Matches `herdr integration status`; detects outdated installs via version markers. |
| K8 | Use integer version markers in embedded assets | Simple current/outdated semantics for the extension and hook shims. |

## Deliverables

| # | Deliverable | File |
|---|---|---|
| 1 | Remove `vp provider add` subcommand and `providerAdd` export | `src/cli.ts`, `src/commands/provider.ts` |
| 2 | Remove `vp hook` subcommand | `src/cli.ts` |
| 3 | Merge `src/commands/hook.ts` logic into `src/commands/integration.ts`; delete `hook.ts` | `src/commands/integration.ts`, `src/commands/hook.ts` (deleted) |
| 4 | Add `vp integration list` | `src/commands/integration.ts`, `src/cli.ts` |
| 5 | Map agent names (`claude`, `codex`, `pi`) in `vp integration install` | `src/commands/integration.ts` |
| 6 | Move and merge hook tests into integration tests; delete hook test file | `src/commands/integration.test.ts`, `src/commands/hook.test.ts` (deleted) |
| 7 | Update docs and help text | `README.md`, `AGENTS.md`, `docs/SETUP.md`, `src/cli.ts` help |
| 8 | Update `package.json` scripts if any reference `vp hook` or `vp provider add` | `package.json` |
| 9 | Create `src/version.ts` with CLI and asset versions | `src/version.ts` |
| 10 | Add version markers to `PI_EXTENSION_SOURCE` and hook shims | `src/pi-extension.ts`, `src/shims/*.mjs` |
| 11 | Implement `vp integration status` with `--outdated-only` | `src/commands/integration.ts`, `src/cli.ts` |
| 12 | Add tests for status detection | `src/commands/integration.test.ts` |

## Worktree Strategy

Single worktree combining two CLI simplifications. All changes land in one PR so the CLI surface diff is reviewable as a unit.

### Track 1: vp-cli-simplify
- **Area**: backend
- **Branch**: `vp-cli-simplify`
- **Base**: `main`
- **Stack position**: 1 (wave 1)
- **Objective**: Drop `vp provider add` and `vp hook`; make `vp config set provider` and `vp integration install` the single registration points; add `vp integration status`.
- **Scope & files**: `src/version.ts` (new), `src/cli.ts`, `src/commands/provider.ts`, `src/commands/integration.ts`, delete `src/commands/hook.ts`, `src/commands/hook.test.ts`, `src/pi-extension.ts`, `src/shims/*.mjs`, `README.md`, `AGENTS.md`, `docs/SETUP.md`, `package.json`.
- **Tasks**:
  - [ ] Remove `vp provider add` case from `src/cli.ts`
  - [ ] Remove `providerAdd` export from `src/commands/provider.ts`
  - [ ] Remove `vp hook` case from `src/cli.ts`
  - [ ] Move hook installation logic from `src/commands/hook.ts` into `src/commands/integration.ts`
  - [ ] Add `vp integration list` to surface install state for all three agents
  - [ ] Map `claude` / `codex` / `pi` to the right installer in `vp integration install`
  - [ ] Delete `src/commands/hook.ts` and `src/commands/hook.test.ts`
  - [ ] Merge any hook tests into `src/commands/integration.test.ts`
  - [ ] Update `README.md`, `AGENTS.md`, `docs/SETUP.md`, and CLI help text
  - [ ] Create `src/version.ts` with `VERSION`, `PI_INTEGRATION_VERSION`, and `HOOK_VERSION`
  - [ ] Add `VISION_PROXY_INTEGRATION_VERSION=1` marker to `PI_EXTENSION_SOURCE`
  - [ ] Add `VISION_PROXY_HOOK_VERSION=1` marker to hook shims
  - [ ] Implement `vp integration status [agent] [--outdated-only]`
  - [ ] Add unit tests for status detection
  - [ ] Run `npm test && npm run typecheck && fallow audit`
- **Verification**: `npm test && npm run typecheck && fallow audit`
- **Depends on**: none

## Tools / MCP / Skills

- `agents-docs` for plan and worktree tracking.
- `review-gate` before merging.
- Native tools: `git`, `wt`, `npm`, `fallow`.

## Risks

- **Breaking change.** Users on `vp hook install` or `vp provider add` will hit unknown-subcommand after the upgrade.
- **Test churn.** Hook tests must be merged into integration tests; provider tests lose the `providerAdd` case.
- **Doc churn.** README, AGENTS, SETUP all reference the dropped commands.
- **Merge ordering.** This branch touches `src/cli.ts` alongside the `vp-help-output` worktree; merge `vp-cli-simplify` last so it absorbs the smaller CLI edit cleanly.

## Related

- `../research/backend-pi-hook-versus-integration-support.md` — research that motivated the unification.
- `../research/backend-integration-status-command.md` — research that motivated the status command.
- `../plans/backend-integration-status-command.md` — handoff plan for the status work on this branch.
- `../archive/research-backend-vision-proxy-review-run-lessons.md` — captures the decision matrix from the post-merge review.
