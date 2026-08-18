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

- [ ] Replace `baseURLs` with `baseUrl: string` in `VisionConfig`, `DEFAULT_CONFIG`, env parsing, and persisted keys.
- [ ] Update `analyze.ts` to use `config.baseUrl`.
- [ ] Update `config.ts` coercion.
- [ ] Update unit tests.
- [ ] Update config documentation.

## Verification

npm test

## Status

- [ ] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
