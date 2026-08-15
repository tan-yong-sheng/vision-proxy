---
type: plan
title: Add fallbackModels config key with comma-separated parser for vp config set
description: "Support a list of fallback model ids (provider/model) in the config so vp can retry with a different model when the primary is rate-limited or doesn't support images."
area: backend
tags: [config, fallback, model]
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related: [../archive/plan-backend-vision-proxy-post-migration-feature-set.md, ../plans/backend-add-config-keys-for-fallback-models-and-provider-baseurl.md]
superseded_by: ../plans/backend-add-config-keys-for-fallback-models-and-provider-baseurl.md
---
# Add fallbackModels config key with comma-separated parser

## Goal capsule

Allow `vp config set fallbackModels "..."` to set a user-facing fallback model list, parsed as comma-separated `provider/model` strings.

## Current state

- `mode: "fallback"` is a boolean-like toggle — it just says "try the vision model" but doesn't specify **which** model to fall back to.
- `vp config set` writes to `.vision-proxy.json` but only handles `number`/`boolean`/`string` via `coerceValue` — no array support.
- `KNOWN_KEYS` = `Object.keys(DEFAULT_CONFIG)` — `fallbackModels` is not in `VisionConfig`.

## Target state

```bash
vp config set fallbackModels "google/gemini-2.5-flash,openai/gpt-4o"
```

Writes `["google/gemini-2.5-flash", "openai/gpt-4o"]` to `.vision-proxy.json`. The `coerceValue` function detects `*s`-ending keys and splits on `,`.

## Key technical decisions

- **`coerceValue`** in `src/commands/config.ts` checks `typeof DEFAULT_CONFIG[key]` — for `number` it parses, for `boolean` it coerces. A `string` key with no `*_baseURL` / `fallbackModels` match just returns the raw string.
- **`KNOWN_KEYS`** = `new Set(Object.keys(DEFAULT_CONFIG))` — there is NO `fallbackModels` key in `DEFAULT_CONFIG` or `VisionConfig`. So `vp config set fallbackModels` would **fail** with `unknown config key`.
- **Add `fallbackModels` to `VisionConfig`** as `string[]` (comma-separated), and add it to `DEFAULT_CONFIG` in `src/core.ts`.
- **`coerceValue` needs a new branch** — if `key.endsWith("s")` (like `fallbackModels`), split on `,` and trim whitespace.
- **`*_BASE_URL` is NOT in `VisionConfig`** — it's only passed at provider construction via `createOpenAI({ apiKey, baseURL })`. The `readEnvOverrides` function in `src/core.ts` reads `VP_*` env vars but has no `*_BASE_URL` key.
- **`readEnvOverrides`** handles `VP_*` env vars — `VP_OPENAI_BASE_URL` etc. would need to be added to the `readEnvOverrides` parser in `src/core.ts`.

## Deliverables

1. Add `fallbackModels` to `VisionConfig` / `DEFAULT_CONFIG` in `src/core.ts`.
2. Update `coerceValue` in `src/commands/config.ts` to split comma-separated values into arrays when the key ends with `s`.
3. Add `*_baseURL` env var resolution in `readEnvOverrides` in `src/core.ts`.
4. Wire fallback into `runAnalyze` in `src/commands/analyze.ts` — iterate the list and stop on first success.
5. Update `docs/SETUP.md` with the command.

## Worktree Strategy

Single worktree — `src/commands/config.ts` + `src/core.ts` + `src/commands/analyze.ts`.

## Risks

Low — the change is a 3-line `coerceValue` addition; the fallback iteration is a simple `for...of` loop.
