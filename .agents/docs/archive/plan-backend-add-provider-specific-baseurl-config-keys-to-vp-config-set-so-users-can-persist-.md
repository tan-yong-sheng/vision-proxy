---
type: plan
title: Add provider-specific baseURL config keys to vp config set so users can persist custom endpoints
description: "Each Vercel AI SDK provider already accepts baseURL at construction, but vp config set does not expose a baseURL key in VisionConfig. Users must set *_BASE_URL env vars instead of persisting it in .vision-proxy.json."
area: backend
tags: [provider, baseURL]
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ../archive/research-fullstack-vercel-ai-sdk-provider-compatibility-for-openai-gemini-anthropic-compatible-endp.md
  - ./backend-add-config-keys-for-fallback-models-and-provider-baseurl.md
superseded_by: ./backend-add-config-keys-for-fallback-models-and-provider-baseurl.md
---
# Add provider-specific baseURL config keys to vp config set

## Goal capsule

Allow users to persist a custom provider endpoint via `vp config set baseURL` instead of setting `*_BASE_URL` env vars each run.

## Current state

- `DEFAULT_CONFIG` (in `src/core.ts`) has no `*_baseURL` key — only env vars (`VP_*`) and the `VisionConfig` type are supported.
- `KNOWN_KEYS` in `src/commands/config.ts` derives from `Object.keys(DEFAULT_CONFIG)` which has no `*BaseURL` fields.
- Providers do accept `baseURL` at construction (`createOpenAI({ apiKey, baseURL })`) — it's just not exposed to config.

## Target state

```diff
// src/core.ts: VisionConfig
+ openaiBaseURL?: string;
+ anthropicBaseURL?: string;
+ googleBaseURL?: string;
```

Then:
```bash
vp config set openaiBaseURL "http://localhost:8000/v1"
```

persists it in `.vision-proxy.json`, and `resolveConfig` reads it from the config file (not just env var).

## Key technical decisions

- **Per-provider keys** (not a single `baseURL`) — each provider has its own endpoint format; mixing them under one key is confusing.
- **Existing env vars (`VP_OPENAI_BASE_URL` etc.)** should be added to `readEnvOverrides` to set from environment too.

## Deliverables

1. Add `*BaseURL` fields to `VisionConfig` / `DEFAULT_CONFIG` in `src/core.ts`.
2. Add `*_baseURL` to the env override parser in `readEnvOverrides`.
3. `KNOWN_KEYS` in `configSet` will auto-cover the new keys.
4. Update `docs/SETUP.md` to show `vp config set ...` as the persistence path.

## Worktree Strategy

Single worktree — tightly coupled change to `src/core.ts` + `src/commands/config.ts` only.

## Risks

Low — the `baseURL` is already plumbed through at the provider-construction level; this just adds a config-layer key.
