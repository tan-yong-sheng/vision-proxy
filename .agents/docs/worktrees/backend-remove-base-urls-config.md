---
type: worktree
title: Remove baseURLs config surface
description: Implementation track for removing the baseURLs config object from vp.
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

Remove the `baseURLs` config object and `VP_BASE_URLS` env var because provider-specific `*_BASE_URL` env vars already cover custom endpoints.

## Scope

- `src/core.ts` — drop `baseURLs` from config, env parsing, validation, and defaults.
- `src/commands/analyze.ts` — remove `config.baseURLs[provider]` override.
- `src/commands/config.ts` — remove `baseURLs` JSON coercion.
- `src/core.test.ts`, `src/commands/config.test.ts` — remove baseURLs tests.
- `docs/CONFIG.md` — remove `baseURLs` documentation.

## Tasks

- [ ] Remove `baseURLs` from `VisionConfig`, `DEFAULT_CONFIG`, env parsing, and persisted keys.
- [ ] Remove `config.baseURLs` usage from `analyze.ts`.
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
