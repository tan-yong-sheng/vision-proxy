---
type: worktree
title: support apikey in config
description: Implement config-file API key support for vision-proxy.
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-09-01"
related:
  - ../plans/backend-support-apikey-in-vision-proxy-config.md
branch: feat/support-apikey-in-config
pr_strategy: separate
---
# support apikey in config

## Objective

Add an optional `apiKey` field to `VisionConfig` and wire it through `resolveModel` so users can store their provider API key in `~/.vision-proxy/config.json` or `.vision-proxy.json`.

## Scope

- Modify `src/core.ts`: add `apiKey?: string` to `VisionConfig` and `DEFAULT_CONFIG`.
- Modify `src/provider.ts`: accept a config-level key in `resolveModel` (precedence: `--api-key` > env > config > keyring).
- Modify `src/commands/analyze.ts`: pass `config.apiKey` to the model resolution path.
- Modify `src/commands/config.ts`:
  - `config get` masks `apiKey` as `"***"` in printed output.
  - `config validate` uses `config.apiKey` when probing reachability.
- Update `docs/CONFIG.md` with the new key and a security warning.
- Add unit tests for precedence, set/get, and redaction.

## Verification

- `npm test` passes.
- `npm run typecheck` passes.
- `fallow audit --gate-marker agent` passes.
- Manual check: `vp config set apiKey sk-test` writes the key, `vp config get` shows `"***"`, and `vp analyze` falls back to it when env/keyring are empty.

## Status

- [ ] Branch created from `dev`
- [ ] Implementation complete
- [ ] Local checks pass
- [ ] PR opened against `dev`
- [ ] `/review-gate` complete
