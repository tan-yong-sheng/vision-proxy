---
type: research
title: missing user guide coverage
description: Identify gaps in user-facing documentation and propose a docs structure that gets a new user from install to daily use.
area: backend
tags: []
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-09-15"
related: []
---
# missing user guide coverage

## Question

What user-facing documentation is missing so that a new user can pick up `vp` from scratch, set up a provider, configure integrations, and use advanced features without reading source code?

## Findings

### Current docs

```
docs/
  SETUP.md
  providers/
    openai.md
    anthropic.md
    google.md
    acp.md
```

### Gaps identified

1. **Full JSON config examples.**
   - `docs/providers/*.md` only show `vp config set` commands.
   - Users often prefer to copy a complete `~/.vision-proxy/config.json` block and paste it.
   - Missing fields in provider docs: `fallbackModels`, `baseURLs`, `maxImagesPerCall`, `maxBatch`, `cacheSize`, etc.

2. **Integration setup guide.**
   - `vp integration install claude-code`, `vp integration install codex`, `vp integration install pi` are not documented for end users.
   - Users do not know what the integrations do, where files are written, or how to verify/uninstall them.

3. **Binary-as-hook workflow.**
   - PR #7 includes binary-as-hook documentation but it is scattered; no end-user guide explains `vp analyze --hook` or how agents call `vp` from `UserPromptSubmit` hooks.

4. **Environment variable reference.**
   - No single page lists all `VP_*` env vars and provider env vars (`OPENAI_API_KEY`, etc.).

5. **Keyring guide.**
   - Keyring is mentioned in `SETUP.md` but not covered in depth (store-key, list-keys, delete-key, when keyring is unavailable).

6. **Command reference / quick start.**
   - No concise "5-minute quick start" from install to first `vp analyze`.
   - No top-level `docs/README.md` or `docs/QUICKSTART.md`.

7. **Troubleshooting expansion.**
   - Current troubleshooting table is minimal.
   - Missing: ACP subprocess errors, keyring backend failures, missing API keys for fallback providers, image path restrictions.

8. **Provider feature matrix.**
   - No table summarizing which provider supports images, base URLs, keyring, fallback models, etc.

### Proposed docs structure

```
docs/
  README.md                 # overview + links
  QUICKSTART.md             # install -> first analysis in 5 minutes
  SETUP.md                  # provider selection index
  providers/
    openai.md
    anthropic.md
    google.md
    acp.md
  integrations/
    claude-code.md
    codex.md
    pi.md
  CONFIG.md                 # full config schema + JSON examples
  ENV.md                    # environment variable reference
  KEYRING.md                # keyring storage guide
  HOOKS.md                  # binary-as-hook / UserPromptSubmit workflow
  TROUBLESHOOTING.md        # expanded troubleshooting
```

### Recommendations

- Add full `~/.vision-proxy/config.json` examples to every provider doc, including `fallbackModels` and `baseURLs`.
- Create `docs/integrations/*.md` for Claude Code, Codex, and Pi agent integrations.
- Create a `docs/CONFIG.md` with the complete config schema and copy-paste JSON blocks.
- Create a `docs/QUICKSTART.md` for the fastest path from install to first result.
- Keep individual guides short and cross-linked from `SETUP.md`.

## Open questions

- Should we add a `docs/README.md` that mirrors/replaces the repo `README.md` usage section?
- Should provider docs duplicate the full schema or link to a single `CONFIG.md`?
- How much of the binary-as-hook workflow should live in `docs/` versus `.agents/docs/plans/`?
