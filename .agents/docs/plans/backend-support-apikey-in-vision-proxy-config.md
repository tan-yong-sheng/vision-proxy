---
type: plan
title: support apiKey in vision-proxy config
description: Allow users to persist a provider API key in ~/.vision-proxy/config.json (and .vision-proxy.json) as a plain-text fallback behind env vars and the CLI --api-key flag.
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-10-17"
related:
  - ../worktrees/backend-support-apikey-in-config.md
---
# support apiKey in vision-proxy config

## Goal capsule

Add an optional `apiKey` config key to `VisionConfig` so `vp analyze` can read the provider API key from `~/.vision-proxy/config.json` or `.vision-proxy.json`. The key is used only as a fallback after the `--api-key` flag and provider-specific environment variables, and before the OS keyring. Document the security trade-off and redact the key in `vp config get` output.

## Current state

- `VisionConfig` does not include an `apiKey` field.
- `vp config set apiKey <key>` is rejected because `KNOWN_KEYS` is derived from `DEFAULT_CONFIG`.
- API key lookup order in `src/provider.ts` is: CLI `--api-key` > env var (`OPENAI_API_KEY`, etc.) > OS keyring.
- `vp config get` prints the resolved config verbatim via `JSON.stringify`.
- `vp config validate` checks reachability with env vars only, so it reports "missing key" even if a key exists in the config file.

## Target state

- `VisionConfig` exposes `apiKey?: string` with a default of `""`.
- `resolveConfig` carries `apiKey` through `sanitize`.
- `resolveModel` accepts the config-level key as a fallback between env and keyring:
  `--api-key` > env var > `config.apiKey` > OS keyring.
- `vp analyze` passes `config.apiKey` to `resolveModel`.
- `vp config set apiKey <key>` works and writes to `.vision-proxy.json`.
- `vp config get` masks `apiKey` as `"***"` in printed output.
- `vp config validate` respects `config.apiKey` when probing provider reachability.
- `docs/CONFIG.md` documents the new key and warns that it stores the secret in plain text.

## Key technical decisions

1. **Single `apiKey` string, not a per-provider map.**
   The key applies to the configured `provider`. Fallback models that use a different provider still rely on env vars or keyring for that provider. This keeps the surface small and matches the user's request for an `apiKey` field.
2. **Plain-text storage is allowed but discouraged.**
   The config file is user-readable (`600`) on creation, but JSON itself is plain text. We will document that `vp provider store-key` is the safer option and that `apiKey` is intended for headless environments or sandboxes where keyring is unavailable.
3. **Redact by default in `vp config get`.**
   Prevent accidental key leakage in terminal scrollback and screenshots. The resolved config object remains unchanged internally; only the printed output masks the value.

## Deliverables

| # | Deliverable | File(s) |
|---|---|---|
| 1 | Add `apiKey?: string` to `VisionConfig` and `DEFAULT_CONFIG`. | `src/core.ts` |
| 2 | Thread `config.apiKey` into `resolveModel`. | `src/provider.ts` |
| 3 | Pass `config.apiKey` from analyze flags and validate. | `src/commands/analyze.ts`, `src/commands/config.ts` |
| 4 | Mask `apiKey` in `vp config get` output. | `src/commands/config.ts` |
| 5 | Allow `vp config set apiKey <key>`. | `src/commands/config.ts` (via `DEFAULT_CONFIG`) |
| 6 | Update config schema docs. | `docs/CONFIG.md` |
| 7 | Unit tests for precedence, set/get, and redaction. | `src/provider.test.ts`, `src/commands/config.test.ts`, `src/core.test.ts` |

## Worktree Strategy

- One implementation worktree.
- Review the feature worktree directly; no merge-preview needed.

| Worktree doc | Branch | PR strategy | Depends on | Notes |
|---|---|---|---|---|
| [backend-support-apikey-in-config](../worktrees/backend-support-apikey-in-config.md) | `feat/support-apikey-in-config` | separate | - | Targets `dev`. Independent of the hook PR. |

## Risks

| Risk | Mitigation |
|---|---|
| Plain-text secret exposure in committed project config | Document that `.vision-proxy.json` should not be committed with `apiKey`; `~/.vision-proxy/config.json` is user-scoped. |
| `vp config get` leaks key in output | Redact `apiKey` before printing. |
| Keyring precedence confusion | Keep env > config > keyring, matching existing `--api-key` > env precedence. |
| Tests that assert full `config get` output break | Update expectations to expect `"***"` for `apiKey`. |
