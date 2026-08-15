---
type: worktree
title: Keyring credential storage
description: Add optional OS keyring-backed storage for vision-proxy provider API keys.
area: backend
tags: [post-migration, keyring, credentials]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-08-29"
related: [../plans/backend-vision-proxy-post-migration-feature-set.md]
---
# Keyring credential storage

## Branch

- **Worktree branch**: `vp-keyring-storage`
- **Base branch**: `configurable-analyze-image-limit`
- **Depends on**: none

## Objective

Add optional OS keyring-backed API key storage with `vp provider store-key/delete-key/list-keys` and keyring lookup in provider resolution.

## Scope

`src/keyring.ts`, `src/provider.ts`, `src/commands/provider.ts`, `src/provider.test.ts`, `src/commands/provider.test.ts`, `package.json`

## Tasks

- [x] Add `@napi-rs/keyring` as an optional dependency in `package.json`.
- [x] Create `src/keyring.ts` with `storeProviderKey`, `getStoredProviderKey`, `deleteProviderKey`, and `keyringAvailable` helpers.
- [x] Add `vp provider store-key <provider>` (read from stdin/prompt), `delete-key <provider>`, and `list-keys`.
- [x] Integrate keyring lookup into `resolveModel` after explicit flag and env var.
- [x] Add tests with mocked keyring and fallback paths.

## Verification

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
fallow audit
```

## Dispatch

- **Run**: `run_82079408b671`
- **Task**: `task_0ef1c7fa5056`
- **Dispatch**: `ctx_c2a3c6d99451`
- **Terminal**: `term_8bc9e9eb-c627-41ce-b097-80e5a22146d5`
- **Worktree path**: `/home/tys203831/Documents/Coding/vision-proxy/.worktrees/vp-keyring-storage`

## Status

- [x] Worktree created
- [x] Implementation complete (commit `e9c3b92`)
- [x] Tests pass (93 tests)
- [ ] Merged into integration branch
