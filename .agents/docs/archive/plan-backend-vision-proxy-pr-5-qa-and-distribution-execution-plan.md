---
type: plan
title: vision-proxy PR-5 QA and distribution execution plan
description: "Two-phase execution plan for PR-5 QA fixes, pre-existing bug cleanup, npm-free distribution, and Biome + BetterLeaks pre-commit tooling."
area: backend
tags:
  - vision-proxy
  - cli
  - qa
  - distribution
  - hooks
  - biome
  - betterleaks
  - worktree
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
entry_point: true
related:
  - ../qa/backend-post-merge-qa-for-pr-5.md
  - ../plans/backend-fix-pi-uninstall-message.md
  - ../plans/backend-fix-hook-shim-shared-mjs-copy.md
  - ../plans/backend-cli-distribution-strategy.md
  - ../plans/backend-tooling-biome-betterleaks.md
  - ../worktrees/backend-fix-pi-uninstall-message.md
  - ../worktrees/backend-fix-hook-shim-shared-mjs-copy.md
  - ../worktrees/backend-prune-max-tool-calls-per-turn.md
  - ../worktrees/backend-fix-pi-extension-typebox-dependency.md
  - ../worktrees/backend-tooling-biome-betterleaks.md
  - ../archive/worktree-backend-vp-distribution.md
visual: .lavish/worktree-plan.html
---
# vision-proxy PR-5 QA and distribution execution plan

## Goal capsule

Land the PR-5 QA fixes, clean up two active pre-existing bugs, add Biome + BetterLeaks pre-commit tooling, and implement an npm-free distribution pipeline for the `vision-proxy` CLI.

## Current state

- PR-5 merged the vision-proxy CLI migration but left two QA findings in `src/commands/integration.ts`:
  1. `vp integration uninstall pi` prints "was not installed" on the first successful uninstall because `removed` is only set in the host-config branch.
  2. `vp integration install claude-code|codex` can silently skip copying `shared.mjs`, causing an ESM resolve error when the hook runs.
- Two pre-existing bugs are open:
  - `maxToolCallsPerTurn` is exposed in config but never enforced.
  - The generated Pi extension imports `Type` from TypeBox without declaring TypeBox as a dependency.
- No linting/secret-scanning pre-commit tooling exists in the repo.
- No npm-free distribution mechanism exists; users currently install via `npm install -g` or `npm link`.

## Target state

- Both PR-5 QA fixes are merged to `main`.
- Both pre-existing bugs are resolved and archived.
- Biome and BetterLeaks run on every commit via Lefthook.
- Users can install `vp` via Homebrew or a curl installer; GitHub Releases hosts the artifacts.
- All work is tracked in flight logs under `.agents/docs/worktrees/`.

## Key technical decisions

| ID | Decision | Rationale |
|----|----------|----------|
| D1 | Keep `UserPromptSubmit` as the primary hook; `PreToolUse(Read image)` is an optional safety net. | `UserPromptSubmit` carries the user's question naturally and does not interfere with normal reads. `PreToolUse` blocks the `Read` tool before it runs and can only supply a static question. |
| D2 | A hybrid hook setup is acceptable: `UserPromptSubmit` forwards `--question`, `PreToolUse(Read image)` uses a static hard-coded question like `"describe this image"`. | The `Read` tool (Codex `read_file` / Claude Code `Read`) has no question parameter, so per-image questions cannot come from `PreToolUse`. |
| D3 | Keep the Homebrew formula in this repo under `Formula/vision-proxy.rb`. | Avoids creating and maintaining a second repository. |
| D4 | Embed the install-time `vp` path into hook shims, with a PATH fallback. | Removes the need for `VP_BIN`/`VISION_PROXY_PATH` env vars in the common case. |
| D5 | GitHub Releases is the artifact source of truth. Track A (JS `dist/` + Node 22) ships now; Track B (`bun build --compile`) is deferred. | Track A is safe and proven; Track B's native `@napi-rs/keyring` bundling is unproven. |
| D6 | Biome uses the `recommended` rule set plus formatter/import organizer; BetterLeaks starts from the default config with project-specific allowlists. | Minimal, expandable config; auto-fixes run in the tooling PR. |

## Deliverables

1. Merge `backend-prune-max-tool-calls-per-turn` worktree.
2. Merge `backend-fix-pi-extension-typebox-dependency` worktree.
3. Merge `backend-tooling-biome-betterleaks` worktree.
4. Merge `backend-fix-pi-uninstall-message` worktree (Phase 2).
5. Merge `backend-fix-hook-shim-shared-mjs-copy` worktree (Phase 2, stacks on #4).
6. Merge `backend-vp-distribution` worktree (Phase 2, parallel).

## Worktree Strategy

**Phase 1 - parallel pre-existing bugs + tooling**

| Worktree | Branch | Base | Batch |
|----------|--------|------|-------|
| [prune max tool calls per turn](../worktrees/backend-prune-max-tool-calls-per-turn.md) | `configurable-analyze-image-limit` | `main` | `vp-pre-existing-bugs` |
| [fix Pi extension TypeBox dependency](../worktrees/backend-fix-pi-extension-typebox-dependency.md) | `vp-pi-extension` | `main` | `vp-pre-existing-bugs` |
| [tooling: Biome + BetterLeaks](../worktrees/backend-tooling-biome-betterleaks.md) | `vp-tooling-biome-betterleaks` | `main` | `vp-tooling` |

**Phase 2 - QA fixes sequential, distribution parallel**

| Worktree | Branch | Base | Batch | Depends on |
|----------|--------|------|-------|------------|
| [fix pi uninstall message](../worktrees/backend-fix-pi-uninstall-message.md) | `fix/pi-uninstall-message` | `main` | `vp-qa-fixes` | Phase 1 |
| [fix hook shared.mjs copy](../worktrees/backend-fix-hook-shim-shared-mjs-copy.md) | `fix/hook-shim-shared-mjs` | `fix/pi-uninstall-message` | `vp-qa-fixes` | #1 + Phase 1 |
| [vp distribution](../archive/worktree-backend-vp-distribution.md) | `vp-distribution` | `main` | `vp-distribution` | Phase 1 |

## Risks

- `fix pi uninstall message` and `fix hook shared.mjs copy` both edit `src/commands/integration.ts`; they must stay sequential.
- The release tarball must keep `dist/shims/*.mjs` together with the binary, or the missing-`shared.mjs` failure resurfaces.
- `bun build --compile` may not bundle the optional native `@napi-rs/keyring` addon; Track B is deferred until proven.
