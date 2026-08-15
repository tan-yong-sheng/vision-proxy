---
type: plan
title: integration status command handoff
description: Handoff plan for adding `vp integration status` to the existing `vp-cli-simplify` worktree, delegated to a Claude agent via worktrunk-orca-delegation.
area: backend
tags: [integration, hook, status, version, cli, handoff, delegation]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ../research/backend-integration-status-command.md
  - ../research/backend-pi-hook-versus-integration-support.md
  - ./backend-simplify-cli-surface-drop-vp-provider-add-and-unify-vp-hook-into-vp-integration.md
  - ../worktrees/backend-vp-cli-simplify.md
---
# integration status command handoff

## Goal capsule

Add `vp integration status` to the existing `vp-cli-simplify` branch.
The branch already unifies `vp hook` into `vp integration` and adds `vp integration list`.
This plan documents the handoff to a Claude worker that will implement version markers and the status subcommand.

## Why reuse `vp-cli-simplify`?

- The branch is already 1 commit ahead of `main` and 0 behind.
- It contains the unified `AgentSpec` abstraction and `isInstalled` logic needed for status detection.
- `vp integration status` fits naturally into the already-unified `vp integration` command.
- A separate worktree would duplicate effort and create a merge conflict later.

## Current state of the branch

- `vp provider add` is removed.
- `vp hook` is removed; hook logic lives in `src/commands/integration.ts`.
- `vp integration install|show|list|uninstall <agent>` supports `pi`, `claude-code`, and `codex`.
- `src/pi-extension.ts` embeds `PI_EXTENSION_SOURCE` with no version marker.
- `src/shims/*.mjs` contain hook logic with no version marker.
- `VERSION` is hard-coded in `src/cli.ts` and not exported.

## Target state

- `vp integration status` prints one line per agent:
  - `pi: current (v1) (/home/user/.pi/agent/extensions/vision-proxy.ts)`
  - `pi: outdated (legacy < v1) (/home/user/.pi/agent/extensions/vision-proxy.ts)`
  - `pi: not installed (/home/user/.pi/agent/extensions/vision-proxy.ts)`
  - `claude-code: current (v1) (/home/user/.claude/settings.json)`
  - `codex: outdated (v0 < v1) (/home/user/.codex/config.toml)`
- `vp integration status --outdated-only` prints a compact warning only when at least one integration is outdated.
- Each shipped asset carries a version marker comment:
  - `PI_EXTENSION_SOURCE`: `VISION_PROXY_INTEGRATION_VERSION=1`
  - Hook shims: `VISION_PROXY_HOOK_VERSION=1`
- `src/version.ts` exports `VERSION`, `PI_INTEGRATION_VERSION`, and `HOOK_VERSION`.
- Help text and docs are updated.
- Tests cover current, outdated, legacy, and not-installed states for all three agents.

## Key technical decisions

| ID | Decision | Rationale |
|---|---|---|
| K1 | Use integer markers (`VISION_PROXY_INTEGRATION_VERSION=1`, `VISION_PROXY_HOOK_VERSION=1`) | Simple current/outdated semantics; matches herdr; independent of npm semver. |
| K2 | Centralize expected versions in `src/version.ts` | One place to bump when assets change; keeps status detection consistent. |
| K3 | Status checks both the asset file and the agent config for hooks | A hook is only installed if the shim exists and the config still references it. |
| K4 | Missing or unparsable marker = `legacy` / outdated | Matches herdr; users who installed before this feature see an update prompt. |
| K5 | Build on the unified `AgentSpec` abstraction | The `vp-cli-simplify` branch already has the right structure; extend it rather than adding a parallel detector. |

## Deliverables

| # | Deliverable | File |
|---|---|---|
| 1 | Create `src/version.ts` exporting `VERSION`, `PI_INTEGRATION_VERSION`, `HOOK_VERSION` | `src/version.ts` |
| 2 | Import `VERSION` from `src/version.ts` in the CLI | `src/cli.ts` |
| 3 | Add `VISION_PROXY_INTEGRATION_VERSION=1` marker to `PI_EXTENSION_SOURCE` | `src/pi-extension.ts` |
| 4 | Add `VISION_PROXY_HOOK_VERSION=1` marker to hook shims | `src/shims/*.mjs` |
| 5 | Extend `AgentSpec` with version detection | `src/commands/integration.ts` |
| 6 | Implement `integrationStatus(agent?)` with `--outdated-only` | `src/commands/integration.ts`, `src/cli.ts` |
| 7 | Update CLI help text | `src/cli.ts` |
| 8 | Add unit tests for status detection | `src/commands/integration.test.ts` |
| 9 | Update README / AGENTS / SETUP docs if needed | `README.md`, `AGENTS.md`, `docs/SETUP.md` |

## Worktree Strategy

Reuse the existing `vp-cli-simplify` worktree. Do not create a new branch.

### Worktree: vp-cli-simplify
- **Area**: backend
- **Branch**: `vp-cli-simplify`
- **Base**: `main`
- **Status**: active
- **Objective**: Complete the CLI simplification and add `vp integration status`.
- **Scope & files**: `src/version.ts` (new), `src/cli.ts`, `src/pi-extension.ts`, `src/shims/*.mjs`, `src/commands/integration.ts`, `src/commands/integration.test.ts`, `README.md`, `AGENTS.md`, `docs/SETUP.md`.
- **Verification**: `npm test && npm run typecheck && fallow audit`
- **Depends on**: none

The detailed dispatch contract and handoff prompt for the Claude worker are in `../worktrees/backend-vp-cli-simplify.md`.

## Tools / MCP / Skills

- `worktrunk-orca-delegation` for dispatching the Claude worker.
- `agents-docs` for plan and worktree tracking.
- `review-gate` before merging.
- Native tools: `git`, `wt`, `npm`, `fallow`.

## Risks

- **Version marker format.** Integer markers are small and herdr-proven; switching later would require migration logic.
- **Hook status false positives.** The detector must check both config block and referenced shim file.
- **Branch not yet merged.** `vp-cli-simplify` is still a local branch; adding status keeps it unmerged longer.
- **Worker context.** The delegated agent must read the existing branch code carefully before editing; the handoff prompt in the worktree doc mitigates this.

## Related

- `../research/backend-integration-status-command.md` — original research.
- `../research/backend-pi-hook-versus-integration-support.md` — prior research on Pi extension vs hook model.
- `./backend-simplify-cli-surface-drop-vp-provider-add-and-unify-vp-hook-into-vp-integration.md` — parent plan for the unification work.
- `../worktrees/backend-vp-cli-simplify.md` — flight log with the detailed handoff prompt.
