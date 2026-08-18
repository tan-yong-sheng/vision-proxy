---
type: worktree
title: Remove baseURLs config surface
description: Implementation track for replacing baseURLs object with a single baseUrl string.
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-09-01"
related: [../plans/backend-remove-baseurls-config.md]
---
# Remove baseURLs config surface

## Objective

Replace the per-provider `baseURLs` config object with a single `baseUrl` string. Keep provider-specific `*_BASE_URL` env vars for runtime overrides.

## Scope

- `src/core.ts` — replace `baseURLs` with `baseUrl: string`, update env parsing/validation/defaults.
- `src/commands/analyze.ts` — pass `config.baseUrl` to `resolveModel()`.
- `src/commands/config.ts` — coerce `baseUrl` as a plain string.
- `src/core.test.ts`, `src/commands/config.test.ts` — update tests to single-string form.
- `docs/CONFIG.md`, `README.md` — update docs.

## Tasks

- [x] Replace `baseURLs` with `baseUrl: string` in `VisionConfig`, `DEFAULT_CONFIG`, env parsing, and persisted keys.
- [x] Update `analyze.ts` to use `config.baseUrl`.
- [x] Update `config.ts` coercion.
- [x] Update unit tests.
- [x] Update config documentation.

## Verification

npm test

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [x] Landed on feature branch (ready for PR/merge)
