---
type: coverage
title: "Post-merge QA for PR #5"
description: Manual validation findings for the merged vision-proxy CLI cleanup branches.
area: backend
tags: [cli, integration, config, qa, pr-5, post-merge]
status: retired
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-11-13"
related: [../archive/coverage-backend-vp-cli-cleanup-merge-preview.md]
visual: .lavish/worktree-plan.html
---
# Post-merge QA for PR #5

## Surface covered

Manual validation of the combined state that landed in PR #5 on `main`.

## Findings

### 1. `vp integration uninstall pi` reports wrong success message

- **Observation:** After `vp integration install pi`, the first `vp integration uninstall pi` prints "pi integration was not installed" even though the extension file is removed. A second run prints "nothing to uninstall".
- **Root cause:** `integrationUninstall` only sets `removed = true` when a host config file is edited. Pi has no host config, so the flag stays `false` and the wrong success-message branch runs.
- **Fix branch:** `fix/pi-uninstall-message` (pushed to origin, no PR yet).
- **Fix:** Set `removed = true` after successfully deleting the target file; add regression test in `src/commands/integration.test.ts`.
- **Status:** fixed-on-branch, awaiting PR.

### 2. `mode` field still present in `~/.vision-proxy/config.json`

- **Observation:** `vp config get` still shows `"mode": "fallback"` in the resolved config.
- **Investigation:** `mode` is a legitimate config key. It drives `shouldStripImages(config, modelInput)` in `src/core.ts`: `off` disables proxying, `always` always strips images, and `fallback` strips only when the active model is not vision-capable.
- **Status:** not a bug; expected behavior. The field should not be deleted unless the feature is intentionally removed.

### 3. Consider removing `vp integration list` in favor of `vp integration status`

- **Observation:** `vp integration list` prints a simple checklist of installed agents. `vp integration status` already shows installed state plus version markers, making `list` redundant.
- **Proposed change:** Remove the `list` subcommand and fold its behavior into `status` (or drop it entirely). The status output already covers the same surface with more information.
- **Status:** proposal recorded, no code changes yet. Needs decision before editing.

### 4. Hook agents (claude-code, codex) fail at runtime with ESM resolve error

- **Observation:** After installing the Claude Code or Codex hook, submitting an image prompt fails with `node:internal/modules/esm/resolve:272` from the UserPromptSubmit hook.
- **Root cause:** `vp integration install claude-code|codex` writes the generated shim into `dist/shims/` and then copies `shared.mjs` from `shimDir()` next to it. `shimDir()` resolves to `dist/shims/` when running the built CLI, but if `dist/shims/shared.mjs` is absent (e.g., stale build), the copy is silently skipped. The installed shim then imports `./shared.mjs` which does not exist, causing the ESM resolve error at hook runtime.
- **Reproduction:** Remove `dist/shims/shared.mjs`, run `vp integration install claude-code` (or `codex`), then trigger the hook. The install reports success but the hook fails.
- **Affected agents:** `claude-code`, `codex`.
- **Proposed fix:** Make the install copy `shared.mjs` from `src/shims/` as a fallback when `shimDir()` does not contain it, or make `shimDir()` verify that `shared.mjs` exists in the resolved directory and fall back to `src/shims/` otherwise.
- **Status:** root cause confirmed, fix proposed, no code changes yet.

## Matrix

| Check | Result |
|-------|--------|
| `vp integration uninstall pi` after install | Bug found; fix on `fix/pi-uninstall-message` |
| `vp config get` shows `mode` | Expected; `mode` is still a supported key |
| `vp integration install claude-code / codex` writes `shared.mjs` next to the shim | Bug found: installed shim imports `./shared.mjs` which ESM-resolves only if the sidecar ships; Claude Code and Codex both hit this at hook runtime. Fix on `fix/hook-shim-shared-mjs` (always copy `shared.mjs`, fail loudly if missing). |

## Retirement criteria

Retire this dossier once all findings are resolved/answered and any follow-up PRs have landed in `main`.
