---
type: research
title: allow api key in config json
description: Evaluate allowing API keys to be stored in ~/.vision-proxy/config.json.
area: backend
tags: []
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-09-15"
related: []
---
# allow api key in config json

## Question

Should `vp` support writing API keys in `~/.vision-proxy/config.json` (or `.vision-proxy.json`) even though keyring storage is preferred, so users who accept the security trade-off have an easier option?

## Findings

### Current state

- API keys are resolved from:
  1. Explicit `--api-key` CLI flag.
  2. Provider-specific environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`).
  3. OS keyring via `vp provider store-key`.
- `VisionConfig` in `src/core.ts` has no `apiKey` or `apiKeys` field.
- `config set` rejects unknown keys via `KNOWN_KEYS`.
- `.vision-proxy.json` / `~/.vision-proxy/config.json` are intended to be safe to commit (they contain no secrets).

### Pros of allowing config-file keys

1. **Convenience.** Users do not need to set env vars in every shell or use keyring tooling.
2. **Scripting and CI.** Plain-text config is easier to inject in automation, containers, and ephemeral environments where keyring is unavailable.
3. **User choice.** Some users explicitly prefer ease over maximum secret protection.
4. **Competitive parity.** Many CLI tools allow keys in config files with a warning.

### Cons and risks

1. **Accidental secret exposure.** Project-level `.vision-proxy.json` can be committed to git.
2. **Weaker security model.** Config files are readable by any process running as the user; keyring restricts access.
3. **Mixed precedence confusion.** Users may be surprised if a config-file key overrides or is overridden by env vars/keyring.
4. **Scope of compromise.** One leaked config file may expose multiple provider keys.

### Design options

| Option | Description | Trade-off |
|--------|-------------|-----------|
| A. Single `apiKey` | One key for the active `provider` | Simple, but does not support fallback models across providers |
| B. `apiKeys` map | `{ "openai": "sk-...", "anthropic": "..." }` | Supports fallback models, but more complex |
| C. User-config only | Allow keys only in `~/.vision-proxy/config.json`, not project `.vision-proxy.json` | Reduces commit risk, still plain text |
| D. Opt-in flag | Require `allowApiKeyInConfig: true` before reading config keys | Adds friction but makes the trade-off explicit |
| E. `.env` support | Read keys from `.env` files instead of config JSON | Familiar pattern, but still plain text |

### Recommendations

- **Allow config-file API keys with strong guardrails.** Prefer option B (`apiKeys` map) so fallback models work, combined with a clear security warning.
- Add a `vp config set apiKeys '{"openai":"sk-..."}'` path and support it in `resolveConfig`/`resolveModel`.
- Keep keyring and env vars as the recommended methods in documentation.
- Emit a warning when a key is read from config file, and warn in `config validate` if `apiKeys` is present.
- Consider adding `.vision-proxy.json` to the project's `.gitignore` template or documentation guidance.
- Do **not** include `apiKeys` in `config init` defaults.

### Execution note

This change touches `VisionConfig`, `resolveConfig`, `resolveModel`, `config set`, `config get`, tests, and documentation.
It is a code change with security implications, so it should be implemented in its own worktree and reviewed as a **separate PR** from the ACP/OSV/docs work.

## Open questions

- Should project-level `.vision-proxy.json` be allowed to contain `apiKeys`, or only the user-level `~/.vision-proxy/config.json`?
- Should `config set` warn or require `--force` when writing an `apiKeys` value?
- Should we add a redaction helper so `config get` hides config-file keys by default?
