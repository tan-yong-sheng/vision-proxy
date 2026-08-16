---
type: worktree
title: vp-remove-allow-home
description: "Drop `VP_ALLOW_HOME` and let `vp analyze` read image paths anywhere on the local filesystem by default; delegate permission enforcement to the OS sandbox (for example nono)."
area: backend
tags: [security, cli, path-restriction]
status: landed
branch: vp-remove-allow-home
base: main
stack_position: 1
note: "Local branch `vp-remove-allow-home` already exists (no commits); re-purpose it."
created: "2026-08-15"
updated: "2026-08-15"
commits_verified: ["vp-remove-allow-home@1fc80ff"]
stale_after: "2026-08-29"
related: [../plans/backend-remove-vp-allow-home-path-restriction.md]
---
# vp-remove-allow-home

## Branch

`vp-remove-allow-home` (off `main`). The local branch already exists with no commits; re-purpose it for this work.

## Objective

Drop `VP_ALLOW_HOME` and let `vp analyze` read image paths anywhere on the local filesystem by default; delegate permission enforcement to the OS sandbox (for example nono).

## Scope

`src/core.ts` (`isPathAllowed` + `homeRoot`), `src/core.test.ts`, hook/integration tests, `src/cli.ts` (help text), `README.md`, `AGENTS.md`, `docs/SETUP.md`.

## Tasks

- [x] Remove the `VP_ALLOW_HOME` branch from `isPathAllowed` in `src/core.ts`
- [x] Update the home-path error message to drop `VP_ALLOW_HOME` references
- [x] Rewrite tests that asserted home paths are denied
- [x] Update README, AGENTS, docs/SETUP, and CLI help text
- [x] Run `npm test && npm run typecheck && fallow audit`

## Verification

`npm test && npm run typecheck && fallow audit`

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [ ] Merged into integration branch
