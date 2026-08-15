---
type: worktree
title: backend-integration-status
description: "Add `vp integration status` and `vp hook status` with version markers and tests."
area: backend
tags: [integration, hook, status, version, cli]
status: abandoned
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-08-29"
related: [../plans/backend-integration-status-command.md]
---
# backend-integration-status

## Objective

Add `vp integration status` and `vp hook status` with version markers and tests.

## Scope

`src/version.ts` (new), `src/cli.ts`, `src/pi-extension.ts`, `src/shims/*.mjs`, `src/commands/integration.ts`, `src/commands/hook.ts`, `src/commands/integration.test.ts`, `src/commands/hook.test.ts`, `README.md`, `AGENTS.md`.

## Tasks

- [ ] Create `src/version.ts` with `VERSION`, `PI_INTEGRATION_VERSION`, `HOOK_VERSION`.
- [ ] Update `src/cli.ts` to import `VERSION` and update help text.
- [ ] Add version markers to `PI_EXTENSION_SOURCE` and hook shims.
- [ ] Implement Pi extension status detection in `src/commands/integration.ts`.
- [ ] Implement hook status detection in `src/commands/hook.ts`.
- [ ] Wire `vp integration status [agent] [--outdated-only]`.
- [ ] Wire `vp hook status [agent] [--outdated-only]`.
- [ ] Add unit tests for current/outdated/legacy/not-installed states.
- [ ] Update README and AGENTS if needed.
- [ ] Run `npm test && npm run typecheck && fallow audit`.

## Verification

`npm test && npm run typecheck && fallow audit`

## Status

- [ ] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Merged into integration branch
