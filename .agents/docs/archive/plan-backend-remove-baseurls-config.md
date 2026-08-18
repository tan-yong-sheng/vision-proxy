---
type: plan
title: Remove baseURLs config
description: Replace the per-provider baseURLs object in config with a single baseUrl string for the active provider.
area: backend
tags: []
status: complete
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-10-17"
related: []
---
# Replace baseURLs object with a single baseUrl string

## Goal capsule

Replace the per-provider `baseURLs: Record<string, string>` config object with a single `baseUrl: string` config key. The active provider's endpoint can still be overridden via provider-specific `*_BASE_URL` env vars, but `~/.vision-proxy/config.json` will contain one simple `"baseUrl": "https://..."` entry instead of a nested provider map.

## Current state

- `src/core.ts` defines `baseURLs: Record<string, string>` with `VP_BASE_URLS` env parsing and per-provider validation.
- `src/commands/analyze.ts` passes `config.baseURLs[provider]` as the `baseURL` override to `resolveModel()`.
- `src/commands/config.ts` coerces `baseURLs` from a JSON literal.
- Tests cover the object form.
- `docs/CONFIG.md` documents `baseURLs` with per-provider examples.

## Target state

- Config has `baseUrl: string` (default `""`).
- No `baseURLs`, no `VP_BASE_URLS`.
- `vp analyze` passes `config.baseUrl` to `resolveModel()`. Provider `*_BASE_URL` env vars still take precedence.
- Tests and docs updated to the single-string form.

## Key technical decisions

- Keep provider-specific `*_BASE_URL` env vars for per-provider overrides at runtime.
- The single `baseUrl` config applies to the currently selected provider, matching the user's mental model of "one provider per config file".
- Breaking config change for pre-1.0; no deprecation alias for the removed object form.

## Deliverables

- `feat/remove-base-urls-config` branch with the refactor.
- Updated tests passing (`npm test`).
- Updated `docs/CONFIG.md` and `README.md`.

## Worktree Strategy

### `feat/remove-base-urls-config` — Replace baseURLs object with baseUrl string

- **Branch:** `feat/remove-base-urls-config`
- **Objective:** Replace `baseURLs` object with `baseUrl` string in config, env parsing, analyze, tests, and docs.
- **Scope & Files:** `src/core.ts`, `src/commands/analyze.ts`, `src/commands/config.ts`, `src/core.test.ts`, `src/commands/config.test.ts`, `docs/CONFIG.md`, `README.md`.
- **Depends On:** none
- **Verification Criteria:** `npm test`, `npm run typecheck`.

## Risks

- Existing configs with `baseURLs` object will be ignored; users must migrate to `baseUrl` string or `*_BASE_URL` env vars.
- Ensure `resolveModel()` still prefers provider env var over config `baseUrl`.
