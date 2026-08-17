---
type: bug
title: claude code and codex hooks not working
description: Claude Code and Codex UserPromptSubmit hooks fail to install or run correctly for vision-proxy.
area: backend
tags: []
status: open
created: "2026-08-16"
updated: "2026-08-17"
priority: medium
entry_point: true
stale_after: "2026-09-15"
related:
  - https://github.com/Dicklesworthstone/destructive_command_guard
  - https://github.com/ogulcancelik/herdr
  - ../plans/backend-add-pretooluse-read-hook.md
  - ../research/backend-codex-pretooluse-hook-feasibility-confirmation.md
  - ../research/backend-claude-code-hook-feasibility-openclaude-confirmation.md
  - ../archive/research-backend-claude-code-and-codex-hook-patterns.md
  - ../archive/backend-vision-proxy-hook-shims.md
  - ../archive/plan-backend-binary-as-hook-vision-proxy-integration.md
  - ../archive/backend-vision-proxy-shared-shim.md
---
# claude code and codex hooks not working

## Repro

1. Run `vp integration install claude` (or the equivalent Codex install command) on a fresh project.
2. Submit a user prompt that references an image file path.
3. Observe that the hook either does not fire, does not invoke `vp analyze`, returns an error, or does not inject the image description back into the prompt context.
4. Repeat for `vp integration install codex`.

## Root cause

See ../archive/research-backend-claude-code-and-codex-hook-patterns.md for the investigation and ../plans/backend-add-pretooluse-read-hook.md for the fix plan.

Current hypothesis:

- The existing `UserPromptSubmit` shim may be failing at install or runtime because of the `./shared.mjs` sidecar dependency, the `node` invocation path, or changes in Claude Code / Codex hook configuration files.
- vision-proxy currently installs only `UserPromptSubmit`; it does not intercept `PreToolUse Read(image_path)` tool calls, which is the second required hook surface.

## Fix

Feasibility confirmed for both Claude Code and Codex hooks. The fix is tracked in ../plans/backend-add-pretooluse-read-hook.md.

High-level approach:

1. Add a single `vp hook` binary subcommand that dispatches `UserPromptSubmit` and `PreToolUse Read` events.
2. Replace the existing `.mjs` shim + `shared.mjs` sidecar installation with absolute-path `vp hook` command registrations.
3. Register both hook types in Claude Code `~/.claude/settings.json` and Codex `~/.codex/hooks.json`.

Constraints for the fix:

- Use only `UserPromptSubmit` hooks for prompt-time image detection.
- Use only `PreToolUse` `Read(image_path)` hooks where appropriate for tool-use interception.
- Avoid broader hook surface; keep the implementation scoped to image-analysis dispatch.

## Verification

- [ ] Reproduced on a clean environment with no prior hooks installed.
- [ ] `vp integration install claude` creates a working hook.
- [ ] `vp integration install codex` creates a working hook.
- [ ] A prompt referencing an image path triggers `vp analyze` and receives a description.
- [ ] A `PreToolUse Read(image_path)` flow, if supported, correctly dispatches to `vp analyze`.
- [ ] Linked to the fix commit / QA dossier once resolved.
