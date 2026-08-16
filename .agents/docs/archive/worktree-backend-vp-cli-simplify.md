---
type: worktree
title: vp-cli-simplify
description: "Drop `vp provider add` and `vp hook`, unify `vp integration install/show/list/uninstall`, and add `vp integration status` with version markers."
area: backend
tags: [cli, hook, integration, provider, refactor, status, version]
status: landed
merged_commit: b097e3c
branch: vp-cli-simplify
base: main
stack_position: 1
created: "2026-08-15"
updated: "2026-08-16"
commits_verified: ["vp-cli-simplify@8f054d2", "vp-cli-simplify@b487137"]
merge_preview_verified: "qa/vp-cli-cleanup-merge@65cd747"
stale_after: "2026-08-29"
related:
  - ../plans/backend-simplify-cli-surface-drop-vp-provider-add-and-unify-vp-hook-into-vp-integration.md
  - ../plans/backend-integration-status-command.md
  - ../qa/backend-vp-cli-cleanup-merge-preview.md
---
# vp-cli-simplify

## Branch

`vp-cli-simplify` (off `main`). Merge last because it touches `src/cli.ts` heavily.

## Objective

Complete the CLI simplification branch and add `vp integration status` so users can see whether Pi, Claude Code, and Codex integrations are installed and up to date.

The branch already contains the unification commit (`8f054d2`). The remaining work is to add version markers to the embedded assets and implement the status subcommand.

## Scope

`src/version.ts` (new), `src/cli.ts`, `src/pi-extension.ts`, `src/shims/*.mjs`, `src/commands/integration.ts`, `src/commands/integration.test.ts`, `README.md`, `AGENTS.md`, `docs/SETUP.md`.

## Tasks

### Already completed in `8f054d2`

- [x] Remove `vp provider add` case from `src/cli.ts`
- [x] Remove `providerAdd` export from `src/commands/provider.ts`
- [x] Remove `vp hook` case from `src/cli.ts`
- [x] Move hook installation logic from `src/commands/hook.ts` into `src/commands/integration.ts`
- [x] Add `vp integration list` to surface install state for all three agents
- [x] Map `claude` / `codex` / `pi` to the right installer in `vp integration install`
- [x] Delete `src/commands/hook.ts` and `src/commands/hook.test.ts`
- [x] Merge hook tests into `src/commands/integration.test.ts`
- [x] Update `README.md`, `AGENTS.md`, `docs/SETUP.md`, and CLI help text
- [x] Run `npm test && npm run typecheck && fallow audit`

### Completed work

- [x] Create `src/version.ts` exporting `VERSION`, `renderVersionMarker`, and `extractMarkerVersion`.
- [x] Update `src/cli.ts` to add `status` to the `integration` subcommand surface.
- [x] Stamp `__VP_VERSION__:<running_version>` marker into `PI_EXTENSION_SOURCE` in `src/pi-extension.ts`.
- [x] Stamp `__VP_VERSION__:<running_version>` marker into the hook shims in `src/shims/*.mjs`.
- [x] Extend `AgentSpec` in `src/commands/integration.ts` with `installedVersion`.
- [x] Implement `integrationStatus()` reporting installed, outdated, and legacy states for all agents.
- [x] Wire `vp integration status` in `src/cli.ts`.
- [x] Add unit tests for current, outdated, legacy, and not-installed states.
- [x] Update help text and `README.md`.
- [x] Run `npm test && npm run typecheck && fallow audit`.

## Verification

`npm test && npm run typecheck && fallow audit`

## Status

- [x] Worktree created
- [x] Base unification implemented
- [x] Tests pass for base unification
- [x] Status command implemented
- [x] Status command tests pass
- [x] Merge preview QA passed
- [ ] Merged into integration branch

## Implementation notes

The status command uses the running `package.json` version as the source of truth.
Generated artifacts include a `__VP_VERSION__:<version>` marker; `integration status` compares the marker in each installed artifact against the running version.
This avoids hardcoded integer version constants and keeps artifacts self-describing.

A small refactor extracted `isAgentInstalled(spec)` from the duplicated loops in `integrationList` and `integrationStatus` so the `fallow audit` gate stays clean.

## Verification log

Branch:

```bash
npm test        # 117 unit tests + 3 e2e shim tests pass
npm run typecheck  # clean
fallow audit --format json --quiet --explain --gate-marker agent  # verdict: pass
```

Merge preview (all four cleanup branches combined):

```bash
npm test        # 138 unit tests + 3 e2e shim tests pass
npm run typecheck  # clean
fallow audit --format json --quiet --explain --gate-marker agent  # verdict: pass
```

## Handoff prompt for Claude worker

You are continuing the existing branch `vp-cli-simplify`.
The branch already unifies `vp hook` into `vp integration` and adds `vp integration list`.
Your job is to add `vp integration status` with version-marker based outdated detection.

### Context to read first

1. Read `./research-backend-integration-status-command.md` for the research.
2. Read `./plan-backend-integration-status-command.md` for the detailed plan.
3. Inspect the current branch code:
   - `src/commands/integration.ts` (unified install/show/list/uninstall logic)
   - `src/pi-extension.ts` (embedded Pi extension source)
   - `src/shims/*.mjs` (hook shims)
   - `src/cli.ts` (CLI wiring)
   - `src/commands/integration.test.ts` (existing tests)

### What to implement

1. Create `src/version.ts`:
   - Export `VERSION` (initially `"0.1.0"`).
   - Export `PI_INTEGRATION_VERSION = 1`.
   - Export `HOOK_VERSION = 1`.
   - Update `src/cli.ts` to import `VERSION` from there.

2. Add version markers:
   - In `PI_EXTENSION_SOURCE`, add a comment line `VISION_PROXY_INTEGRATION_VERSION=1` near the top.
   - In each `src/shims/*.mjs` file, add a comment line `VISION_PROXY_HOOK_VERSION=1` near the top.

3. Implement status detection in `src/commands/integration.ts`:
   - Add a method to `AgentSpec` that can extract the version marker from the installed artifact.
   - For Pi: read `~/.pi/agent/extensions/vision-proxy.ts` and parse `VISION_PROXY_INTEGRATION_VERSION=N`.
   - For Claude Code: check `~/.claude/settings.json` for the `vision-proxy` marker, then read the referenced shim file and parse `VISION_PROXY_HOOK_VERSION=N`.
   - For Codex: check `~/.codex/config.toml` for the `vision-proxy` marker, then read the referenced shim file and parse `VISION_PROXY_HOOK_VERSION=N`.
   - Missing file = `not installed`.
   - File exists but marker missing = `outdated (legacy)`.
   - File exists and marker >= expected = `current (vN)`.
   - File exists and marker < expected = `outdated (vN < vM)`.

4. Wire CLI:
   - `vp integration status` prints one line per agent (or just the requested agent).
   - `vp integration status --outdated-only` prints a compact warning only when something is outdated, exits 0 either way.

5. Add tests in `src/commands/integration.test.ts` covering:
   - Pi: not installed, current, outdated, legacy.
   - Claude Code: not installed, current, outdated, legacy.
   - Codex: not installed, current, outdated, legacy.

6. Update help text in `src/cli.ts` and any docs that mention `vp integration`.

### Constraints

- Do not change the unified command surface already on the branch.
- Do not reintroduce `vp hook` as a top-level command.
- Keep the `AgentSpec` abstraction intact; status detection should live inside it.
- Tests must use isolated temp HOME, like existing tests.
- Run `npm test && npm run typecheck && fallow audit` before marking done.

### Acceptance criteria

- `vp integration status` shows correct state for `pi`, `claude-code`, and `codex`.
- `--outdated-only` behaves like herdr: warns only when outdated.
- Version markers are present in shipped assets.
- All tests pass.
- Typecheck passes.
- Fallow audit is clean.
- The work is committed on `vp-cli-simplify`.

### Verification before worker_done

Run:

```bash
npm test
npm run typecheck
fallow audit --format json --quiet --explain --gate-marker agent
```

If all pass, commit with a conventional commit message and mark the task complete.
