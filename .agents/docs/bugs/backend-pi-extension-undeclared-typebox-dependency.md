---
type: bug
title: Pi extension template undeclared typebox runtime dependency
description: "Generated Pi extension imports Type from typebox without declaring typebox in vision-proxy dependencies."
area: backend
tags: [pi-extension, typebox, dependencies]
status: open
pre-existing: true
owning_branch: vp-pi-extension
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-09-14"
related:
  - ../qa/backend-vision-proxy-post-migration-merge-review.md
  - ../research/backend-vision-proxy-review-run-lessons.md
---

# Pi extension template undeclared typebox runtime dependency

## Repro

1. Install vision-proxy Pi extension via `vp integration install pi` on a clean system.
2. Launch Pi coding agent in an environment where `typebox` is not in Node's resolution path or global modules.
3. Pi attempts to load `~/.pi/agent/extensions/vision-proxy.ts` via `jiti`.
4. Extension load fails with `Cannot find module 'typebox'` during `import { Type } from "typebox"`.

## Root cause

In `src/pi-extension.ts`, `PI_EXTENSION_SOURCE` contains:
```typescript
import { Type } from "typebox";
```
`package.json` for `vision-proxy` does not list `typebox` as a dependency. The extension assumed Pi's runtime environment would always supply `typebox`.

## Fix

Replace the `Type.Object(...)` TypeBox schema construction in `PI_EXTENSION_SOURCE` with standard JSON Schema. Because Pi's `ExtensionAPI.registerTool` accepts standard JSON Schema, inlining the schema eliminates the `typebox` import and makes the generated extension completely dependency-free.

## Verification

1. Generate `dist/pi-extension.js`.
2. Inspect template output: verify no `import ... from "typebox"` exists.
3. Run `npm test` and Pi extension unit tests in `src/commands/integration.test.ts`.

## Regression check

Ensure `vp integration install pi`, `vp integration show pi`, and tool schema parsing by Pi ExtensionAPI function correctly without external modules.
