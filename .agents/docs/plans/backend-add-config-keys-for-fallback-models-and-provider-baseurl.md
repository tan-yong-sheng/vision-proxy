---
type: plan
title: Add config keys for fallback models and provider baseURL
description: Persist user-facing fallback model lists and provider baseURL endpoints in `.vision-proxy.json` instead of forcing users to set env vars each run.
area: backend
tags: [config, fallback, baseURL, provider]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ./backend-add-fallbackmodels-config-key-with-comma-separated-parser-for-vp-config-set.md
  - ./backend-add-provider-specific-baseurl-config-keys-to-vp-config-set-so-users-can-persist-.md
---
# Add config keys for fallback models and provider baseURL

## Goal capsule

Persist user-facing fallback model lists and provider baseURL endpoints in `.vision-proxy.json` so users do not have to set env vars each run. Combines the legacy `add-fallbackmodels-config-key` and `add-provider-specific-baseurl-config-keys` plans into one worktree because both touch the same `VisionConfig` and `readEnvOverrides` plumbing.

## Current state

- `VisionConfig` and `DEFAULT_CONFIG` (in `src/core.ts`) have no `fallbackModels` key and no `*BaseURL` fields.
- `KNOWN_KEYS` in `src/commands/config.ts` is `new Set(Object.keys(DEFAULT_CONFIG))` — `vp config set fallbackModels` and `vp config set openaiBaseURL` currently fail with `unknown config key`.
- `coerceValue` in `src/commands/config.ts` handles `number` / `boolean` / `string` only — there is no array branch.
- `readEnvOverrides` in `src/core.ts` reads `VP_*` env vars but does not surface `*_BASE_URL`. Custom endpoints must be passed as raw env vars each shell session.
- Provider construction accepts `baseURL` at `createOpenAI({ apiKey, baseURL })` time — the plumbing is already there, only the config layer is missing.

## Target state

```bash
vp config set fallbackModels "google/gemini-2.5-flash,openai/gpt-4o"
vp config set openaiBaseURL "http://localhost:8000/v1"
vp config set anthropicBaseURL "https://proxy.example.com/v1"
vp config set googleBaseURL "https://proxy.example.com/v1"
```

- `fallbackModels` is parsed as a `string[]` (comma-separated, trimmed).
- `*BaseURL` keys map onto the matching provider's `create*` call.
- `readEnvOverrides` accepts `VP_OPENAI_BASE_URL`, `VP_ANTHROPIC_BASE_URL`, `VP_GOOGLE_BASE_URL` and surfaces them as runtime overrides.
- `docs/SETUP.md` shows `vp config set ...` as the persistent path and lists the env-var fallback.

## Key technical decisions

| ID | Decision | Rationale |
|---|---|---|
| K1 | Add `fallbackModels: string[]` to `VisionConfig` | Type-level declaration matches the comma-separated CLI contract. |
| K2 | Add `openaiBaseURL?`, `anthropicBaseURL?`, `googleBaseURL?` (per-provider) to `VisionConfig` | Avoid a single ambiguous `baseURL` — each provider endpoint format differs. |
| K3 | Extend `coerceValue` to split on `,` and trim when `key.endsWith("s")` | Avoids a hard-coded list of array keys; preserves forward-compat for future plural keys. |
| K4 | In `readEnvOverrides`, parse `VP_OPENAI_BASE_URL`, `VP_ANTHROPIC_BASE_URL`, `VP_GOOGLE_BASE_URL` | Mirrors the existing `VP_*` pattern. Env var precedence over config so transient overrides still work. |
| K5 | In `runAnalyze` (`src/commands/analyze.ts`), iterate `fallbackModels` and stop on first success | Fits the existing `mode: fallback` semantics; minimal change. |

## Deliverables

| # | Deliverable | File |
|---|---|---|
| 1 | Add `fallbackModels: string[]` and `*BaseURL` fields to `VisionConfig` and `DEFAULT_CONFIG` | `src/core.ts` |
| 2 | Extend `coerceValue` with a comma-split branch for `*s`-ending keys | `src/commands/config.ts` |
| 3 | Add `*_BASE_URL` parsing to `readEnvOverrides` | `src/core.ts` |
| 4 | Wire `fallbackModels` iteration into `runAnalyze` | `src/commands/analyze.ts` |
| 5 | Pass `openaiBaseURL`, `anthropicBaseURL`, `googleBaseURL` into `createOpenAI` / `createAnthropic` / `createGoogleGenerativeAI` | `src/adapter.ts` (or wherever providers are constructed) |
| 6 | Update `docs/SETUP.md` and `README.md` | docs |
| 7 | Add tests for array coercion and baseURL env override | `src/core.test.ts`, `src/commands/config.test.ts` |

## Worktree Strategy

Single worktree combining the two legacy config-key plans. All five files are tightly coupled through `VisionConfig`.

### Track 1: config keys
- **Area**: backend
- **Branch**: `vp-config-keys`
- **Base**: `main`
- **Stack position**: 1 (wave 1)
- **Objective**: Persist `fallbackModels` and provider `*BaseURL` keys in `.vision-proxy.json`; respect `*_BASE_URL` env vars as overrides.
- **Scope & files**: `src/core.ts`, `src/commands/config.ts`, `src/commands/analyze.ts`, `src/adapter.ts`, `docs/SETUP.md`, `README.md`.
- **Tasks**:
  - [ ] Add `fallbackModels: string[]` and `*BaseURL` keys to `VisionConfig` and `DEFAULT_CONFIG`
  - [ ] Extend `coerceValue` to split on `,` for plural keys
  - [ ] Add `*_BASE_URL` parsing to `readEnvOverrides`
  - [ ] Pass `*BaseURL` into `createOpenAI` / `createAnthropic` / `createGoogleGenerativeAI`
  - [ ] Iterate `fallbackModels` in `runAnalyze`, stop on first success
  - [ ] Update `docs/SETUP.md` and `README.md`
  - [ ] Add tests for array coercion, env override precedence, and fallback iteration
- **Verification**: `npm test && npm run typecheck && fallow audit`
- **Depends on**: none

## Risks

- **`coerceValue` heuristic (`endsWith("s")`)** could misfire on future singular keys ending in `s` (e.g. `bias`). The current set is safe; document the rule in code.
- **Env var precedence**: `*_BASE_URL` env vars must override config file values, matching the existing `VP_*` precedence model. A bug here would silently break proxy setups.
- **No test infrastructure for the fallback iteration** yet — first coverage sets the pattern.
