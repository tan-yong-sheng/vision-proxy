---
type: worktree
title: fix pi extension typebox dependency
description: Replace the TypeBox import in the generated Pi extension with inline JSON Schema so the extension has no undeclared runtime dependency.
area: backend
tags: [pi-extension, typebox, dependencies, cli, integration]
status: landed
branch: vp-pi-extension
base: main
stack_position: 1
stack_batch: vp-pre-existing-bugs
created: "2026-08-15"
updated: "2026-08-15"
commits_verified: [pr-6-preview]
merge_preview_verified: qa/pr-5-qa-and-distribution-merge-preview
stale_after: "2026-08-29"
related:
  - ../bugs/backend-pi-extension-undeclared-typebox-dependency.md
  - ../worktrees/backend-fix-pi-uninstall-message.md
---
# fix pi extension typebox dependency

## Objective

Make the generated Pi extension (`~/.pi/agent/extensions/vision-proxy.ts`) dependency-free by replacing the `import { Type } from "typebox"` and `Type.Object(...)` schema construction with standard JSON Schema. Pi's `ExtensionAPI.registerTool` accepts JSON Schema directly, so the external TypeBox dependency can be removed entirely.

## Scope

- `src/pi-extension.ts` - replace the `parameters: Type.Object({ ... })` block with an equivalent inline JSON Schema object; remove `import { Type } from "typebox"`.
- `src/commands/integration.test.ts` - update Pi extension tests if they assert TypeBox-specific output.
- `package.json` - no change needed; TypeBox is not declared and will stop being imported at runtime.

## Tools / MCP / Skills

- `node --test` for unit + e2e tests.
- `vp integration show pi` to inspect generated extension source.
- `fallow audit` for change review.
- `git worktree` / `wt` for isolation.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| Generated source has no TypeBox | `node dist/cli.js integration show pi` | no `import ... from "typebox"`, no `Type.` usage |
| Install still works | `vp integration install pi` | extension written, Pi loads it |
| Tests pass | `npm test` | green |
| Type check | `npm run typecheck` | clean |

## Status

- [ ] Replace `Type.Object(...)` with inline JSON Schema in `PI_EXTENSION_SOURCE`.
- [ ] Remove `import { Type } from "typebox"` from the template.
- [ ] Update Pi extension tests if needed.
- [ ] Run `npm test`, `npm run typecheck`, `fallow audit`.
- [ ] Open PR and merge to `main`.

## Open questions

- None. This fix is independent of the `fix/pi-uninstall-message` worktree but touches the same Pi-extension surface, so landing it in phase 1 keeps phase 2 focused on the uninstall/message bug.
