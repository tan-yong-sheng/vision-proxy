---
type: research
title: Pi hook versus integration support
description: Determine whether `vp hook install pi` is feasible or whether Pi support belongs under `vp integration install pi`, compared to herdr.
area: backend
tags: [pi, hook, integration, extension]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-09-14"
related: []
---
# Pi hook versus integration support

## Question

Can we add `vp hook install pi` so vision-proxy supports Pi the same way it supports Claude Code and Codex?
Herdr uses `herdr integration install pi` to create an extension file at `~/.pi/agent/extensions/*.ts`.
Which approach is correct for vision-proxy?

## Findings

### 1. `vp hook install` is for UserPromptSubmit shims

`src/commands/hook.ts` installs a shim that runs on the agent's `UserPromptSubmit` hook:
- **Claude Code** stores hooks in `~/.claude/settings.json`.
- **Codex** stores hooks in `~/.codex/config.toml`.
- The shim scans the user's prompt for image paths, calls `vp analyze`, and injects descriptions as additional context.

Pi does **not** expose a UserPromptSubmit hook model that matches this pattern.

### 2. Pi uses an extension model

The Pi coding agent loads TypeScript extensions from:
- `~/.pi/agent/extensions/*.ts` (global)
- `.pi/extensions/*.ts` (project-local)

Extensions export a default factory function that receives `ExtensionAPI` and can:
- register tools with `pi.registerTool()`
- subscribe to lifecycle events
- add commands

This is the official way to extend Pi.

### 3. Herdr already uses the Pi extension path

`herdr integration install pi` writes `~/.pi/agent/extensions/herdr-agent-state.ts`.
It does **not** install a UserPromptSubmit hook; it installs a Pi extension that listens to agent events and reports pane state back to Herdr.

Key herdr behaviors:
- Uses an embedded TypeScript asset.
- Adds a version marker comment (`HERDR_INTEGRATION_VERSION=1`).
- Reads the extensions directory from `PI_CODING_AGENT_DIR` or falls back to `~/.pi/agent`.
- Errors if the extensions directory does not exist yet.
- Detects outdated installations by parsing the version marker.

### 4. Vision-proxy already has the correct command

`src/commands/integration.ts` implements `vp integration install pi`.
It writes `~/.pi/agent/extensions/vision-proxy.ts` using the embedded `PI_EXTENSION_SOURCE` template from `src/pi-extension.ts`.

The generated extension registers an `analyze_image` tool that shells out to `vp analyze`.
This is the Pi-idiomatic equivalent of herdr's Pi extension.

### 5. `vp hook install pi` would be the wrong abstraction

A UserPromptSubmit hook for Pi does not exist in Pi's public model.
Trying to add `pi` to `vp hook install` would either:
- be misleading, because it would actually do the same work as `vp integration install pi`, or
- require Pi to support a hook mechanism that is not documented.

## Conclusion

**Do not add `vp hook install pi`.**

Pi support should stay under `vp integration install pi` because Pi's extension model is the right integration point.
This matches herdr's design: `herdr integration install pi` is an extension, not a hook.

## Suggested improvements to `vp integration install pi`

Based on the herdr implementation, we could enhance `src/commands/integration.ts`:

1. **Add a version marker** to `PI_EXTENSION_SOURCE` so future installs can detect outdated files.
2. **Respect `PI_CODING_AGENT_DIR`** env var to locate the Pi extensions directory.
3. **Error if the extensions directory is missing** instead of silently creating it, so users know Pi is not installed.
4. **Detect outdated installations** and report them in `vp integration show pi` or `vp integration install pi`.
5. **Support project-local install** to `.pi/extensions/vision-proxy.ts` in addition to the global `~/.pi/agent/extensions/` path.

## Open questions

- Should `vp hook show pi` be added as a convenience alias that delegates to `vp integration show pi`?
- Should the Pi extension support project-local installs by default when run inside a project with `.pi/extensions/`?

