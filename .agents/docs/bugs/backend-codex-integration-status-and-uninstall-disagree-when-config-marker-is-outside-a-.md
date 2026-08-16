---
type: bug
title: codex integration status and uninstall disagree when config marker is outside a UserPromptSubmit block
description: "codex is reported installed when config.toml contains 'vision-proxy' anywhere, but uninstall fails to remove it when the marker is outside a [[UserPromptSubmit]] block."
area: backend
tags: [cli, integration, codex, config, pre-existing]
status: open
pre-existing: true
owning_branch: tan-yong-sheng/main
created: "2026-08-16"
updated: "2026-08-16"
priority: medium
stale_after: "2026-09-15"
related:
  - ../qa/backend-merge-review-for-binary-as-hook-docs-osv-scanner-ci-and-acp-provider.md
---
# codex integration status and uninstall disagree when config marker is outside a UserPromptSubmit block

## Repro

1. Ensure `~/.codex/config.toml` exists and contains `"vision-proxy"` outside any `[[UserPromptSubmit]]` block (for example, a stale command path without the marker, a comment, or a malformed block).
2. Ensure the codex shim file (`codex-vision-proxy-user-prompt-submit.mjs`) is absent.
3. Run `vp integration status` - codex shows as `✓ codex installed (version unknown)`.
4. Run `vp integration uninstall codex` - output is `codex integration was not installed`.

## Root cause

In `src/commands/integration.ts`:
- `isInstalled(raw)` for codex returns `raw.includes(HOOK_MARKER)` (`"vision-proxy"`) anywhere in the file.
- `remove(raw)` splits on `/^\[\[UserPromptSubmit\]\]/m` and only removes blocks that themselves contain `"vision-proxy"`.
- `integrationStatus()` reports installed when `isAgentInstalled()` returns true, but `integrationUninstall()` reports "was not installed" when `remove()` returns `removed: false` and the shim file is also absent.

The two functions disagree on what "installed" means.

## Fix

Options (choose one):
1. Make `isInstalled()` stricter: require the marker to be inside a `[[UserPromptSubmit]]` block whose `command` points to a codex shim.
2. Make `remove()` fall back to scrubbing any occurrence of the marker from the file when no block contains it.
3. Make `installedVersion()` also inspect the config block when the shim file is missing, so the out-of-date diagnostic is accurate.

## Verification

1. Add a unit test in `src/commands/integration.test.ts` that writes a config with `"vision-proxy"` outside a block and verifies `uninstall codex` removes it or reports correctly.
2. Run `pnpm test` and `pnpm run typecheck`.
3. Run `fallow audit`.
