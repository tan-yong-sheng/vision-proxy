---
type: plan
title: Remove baseURLs config
description: Remove the redundant baseURLs config object because provider-specific *_BASE_URL env vars already cover custom endpoints.
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-10-17"
related: []
---
# Remove baseURLs config

## Goal capsule

Remove the `baseURLs` config surface from `vp`. Custom provider endpoints are still supported via the existing provider-specific `*_BASE_URL` environment variables, so the config object is redundant.

## Current state

- `src/core.ts` defines `baseURLs: Record<string, string>`, `VP_BASE_URLS` env parsing, validation in `fallbackBaseUrls()`, and persisted config key.
- `src/commands/analyze.ts` passes `config.baseURLs[provider]` as the `baseURL` override to `resolveModel()`.
- `src/commands/config.ts` coerces `baseURLs` from a JSON literal.
- Tests in `src/core.test.ts` and `src/commands/config.test.ts` cover `baseURLs` parsing and validation.
- `docs/CONFIG.md` documents the `baseURLs` key.

## Target state

- No `baseURLs` field, env var, or persisted key.
- `vp analyze` no longer reads `config.baseURLs`; only `*_BASE_URL` env vars and explicit `--api-key` remain as auth/endpoint overrides.
- Tests and docs updated.

## Key technical decisions

- Keep provider-specific `*_BASE_URL` env vars; they are the simpler, well-known mechanism.
- Treat this as a breaking config change for pre-1.0; no deprecation alias because the env var replacement already exists and is more idiomatic.

## Deliverables

- `feat/remove-base-urls-config` branch with the removal.
- Updated tests passing (`npm test`).
- Updated `docs/CONFIG.md`.

## Worktree Strategy

### `feat/remove-base-urls-config` — Remove baseURLs config surface

- **Branch:** `feat/remove-base-urls-config`
- **Objective:** Remove `baseURLs` from config/env/defaults and its usage in analyze.
- **Scope & Files:** `src/core.ts`, `src/commands/analyze.ts`, `src/commands/config.ts`, `src/core.test.ts`, `src/commands/config.test.ts`, `docs/CONFIG.md`.
- **Depends On:** none
- **Verification Criteria:** `npm test`, `npm run typecheck`.

## Risks

- Users with `baseURLs` in their config lose the override. They can migrate to `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, or `GOOGLE_BASE_URL`.
- The change touches `resolveModel()` signatures indirectly; ensure `baseURL` parameter still works for env vars.
