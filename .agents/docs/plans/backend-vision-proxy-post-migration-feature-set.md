---
type: plan
title: Vision proxy post-migration feature set
description: Implement lazy cache pruning, Pi extension installer, and optional keyring credential storage after the CLI migration.
area: backend
tags: []
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-10-13"
related: []
---
# Vision proxy post-migration feature set

## Goal capsule

Ship the three follow-up capabilities selected from the migration wrap-up artifact:

1. Lazy cache pruning in `src/cache.ts`.
2. A `vp integration install pi` command that installs a Pi extension backed by the CLI.
3. Optional OS keyring-backed credential storage for provider API keys.

Each feature is independent enough to be implemented in its own worktree, but all three can be merged into `configurable-analyze-image-limit` and shipped together.

## Current state

- The migration to a standalone CLI is complete and has passed `/review-gate`.
- `src/cache.ts` supports explicit pruning via `vp cache prune` but does not age out entries automatically.
- The Pi extension was intentionally removed; only hook shims for Claude Code and Codex remain.
- API keys are resolved only from environment variables or the `--api-key` flag.
- Research docs capture the options and recommendations for each feature:
  - [Lazy cache pruning](../research/backend-lazy-cache-pruning-for-vision-proxy.md)
  - [Pi extension installer](../research/backend-pi-extension-installer-for-vision-proxy.md)
  - [Keyring credential storage](../research/backend-keyring-credential-storage-for-vision-proxy.md)

## Target state

- `cacheMaxAgeDays` is a first-class config key; stale entries are evicted lazily on cache access.
- Pi users can run `vp integration install pi` to get an `analyze_image` tool that delegates to `vp analyze`.
- Users can run `vp provider store-key <provider>` to save API keys in the OS keyring, with keyring lookup integrated into provider resolution.

## Key technical decisions

1. **Lazy cache pruning**: add `cacheMaxAgeDays` to `VisionConfig` and prune on `cacheGet` only, keeping writes simple. Default `30` days; `0` disables.
2. **Pi integration**: generate a single TypeScript extension file into `~/.pi/agent/extensions/vision-proxy.ts` that shells out to `vp`. Start with a global install only; project-local can be added later.
3. **Keyring storage**: use `@napi-rs/keyring` as an optional dependency. Store keys under service `vision-proxy` and account equal to the provider id. Fall back to env/missing-key if the keyring is unavailable.

## Deliverables

| # | Deliverable | File changes |
|---|---|---|
| 1 | Lazy cache pruning | `src/core.ts`, `src/cache.ts`, `src/commands/cache.ts`, `src/cache.test.ts`, `src/commands/config.test.ts` |
| 2 | Pi extension installer | `src/commands/integration.ts`, `src/cli.ts`, `src/pi-extension.ts` (template), `src/commands/integration.test.ts` |
| 3 | Keyring credential storage | `src/keyring.ts`, `src/provider.ts`, `src/commands/provider.ts`, `src/provider.test.ts`, `src/commands/provider.test.ts`, `package.json` |

## Build steps

1. Create worktrees for each feature off `configurable-analyze-image-limit`:
   - `vp-lazy-cache-prune`
   - `vp-pi-extension`
   - `vp-keyring-storage`
2. Implement each feature with tests and update the relevant research doc to `status: complete` when decisions are finalized.
3. Run per-worktree verification: `pnpm install`, `pnpm run build`, `pnpm test`, `pnpm run typecheck`, `fallow audit`.
4. Merge each worktree into `configurable-analyze-image-limit` using a disposable `int-merge` worktree.
5. Run `/review-gate` on the combined branch before any push/PR.

## Risks

- `@napi-rs/keyring` native binaries may fail to install on headless Linux or unusual architectures. Mitigation: make it an optional dependency and fail open.
- The generated Pi extension may drift from the CLI over time. Mitigation: embed the template in the repo and version it with the CLI; require re-install after major upgrades.
- Adding `cacheMaxAgeDays` changes cache behavior; existing users with very old cache files will see a one-time prune. This is expected and harmless.
- Three parallel worktrees increase merge-conflict risk around `src/cli.ts`, `src/core.ts`, and `package.json`. Merge serially and resolve conflicts in the `int-merge` worktree.
