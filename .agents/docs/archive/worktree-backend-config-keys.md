---
type: worktree
title: config keys
description: "Persist `fallbackModels` and provider `*BaseURL` keys in `.vision-proxy.json`; respect `*_BASE_URL` env vars as overrides."
area: backend
tags: [config, fallback, baseURL, provider]
status: merged
branch: vp-config-keys
base: main
stack_position: 1
created: "2026-08-15"
updated: "2026-08-15"
commits_verified: ["vp-config-keys@0d210ba"]
stale_after: "2026-08-29"
related:
  - ../plans/backend-add-config-keys-for-fallback-models-and-provider-baseurl.md
---
# config keys

## Branch

`vp-config-keys` (off `main`).

## Objective

Persist `fallbackModels` and provider `*BaseURL` keys in `.vision-proxy.json`; respect `*_BASE_URL` env vars as overrides.

## Scope

`src/core.ts`, `src/commands/config.ts`, `src/commands/analyze.ts`, `src/adapter.ts`, `docs/SETUP.md`, `README.md`.

## Tasks

- [x] Add `fallbackModels: string[]` and `*BaseURL` keys to `VisionConfig` and `DEFAULT_CONFIG`
- [x] Extend `coerceValue` to split on `,` for plural keys
- [x] Add `*_BASE_URL` parsing to `readEnvOverrides`
- [x] Pass `*BaseURL` into `createOpenAI` / `createAnthropic` / `createGoogleGenerativeAI`
- [x] Iterate `fallbackModels` in `runAnalyze`, stop on first success
- [x] Update `docs/SETUP.md` and `README.md`
- [x] Add tests for array coercion, env override precedence, and fallback iteration

## Verification

`npm test && npm run typecheck && fallow audit`

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [ ] Merged into integration branch
