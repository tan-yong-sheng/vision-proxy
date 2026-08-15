---
type: plan
title: Remove VP_ALLOW_HOME path restriction
description: "Remove the VP_ALLOW_HOME opt-in and allow vp analyze to read image paths anywhere on the filesystem, relying on the OS sandbox for permission enforcement."
area: backend
tags: [security, cli, path-restriction]
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related: [../research/backend-removing-vp-allow-home-path-restriction.md]
---
# Remove VP_ALLOW_HOME path restriction

## Goal capsule

Remove `VP_ALLOW_HOME` so `vp analyze` can read image paths anywhere on the local filesystem by default. Permission enforcement is delegated to the OS-level sandbox (for example nono) rather than duplicated inside the CLI.

## Current state

- `src/core.ts::isPathAllowed` allows paths in `os.tmpdir()` and the current working directory by default.
- Paths inside the home directory require `VP_ALLOW_HOME=1`.
- README, AGENTS, SETUP docs, CLI help, and error messages all mention `VP_ALLOW_HOME`.
- Tests cover the home-denied and home-allowed behavior.

## Target state

- `VP_ALLOW_HOME` is no longer read or documented.
- `isPathAllowed` allows any local absolute path by default, subject only to Windows drive-access controls.
- Home-directory paths work without setting an environment variable.
- All docs, help text, and tests are updated.

## Key technical decisions

1. **Delegate permission control to the sandbox.**
   The CLI will not enforce its own home-directory boundary. External sandboxes such as nono are the right layer for blocking sensitive paths.

2. **Keep Windows drive gating.**
   `VP_ALLOW_DRIVES` remains because it is a platform-specific convenience, not a security boundary.

3. **Simplify `isPathAllowed`.**
   The function can drop the `VP_ALLOW_HOME` branch and the `homeRoot()` helper if they become unused.

## Deliverables

| # | Deliverable | File changes |
|---|---|---|
| 1 | Remove env override from path check | `src/core.ts` |
| 2 | Update error message | `src/core.ts` |
| 3 | Update README | `README.md` |
| 4 | Update agent docs | `AGENTS.md`, `docs/SETUP.md` |
| 5 | Update CLI help | `src/cli.ts` |
| 6 | Update tests | `src/core.test.ts`, any hook/integration tests |

## Worktree Strategy

Single worktree; the change touches one code path and its documentation/tests. The branch `vp-remove-allow-home` already exists locally with no commits; it will be re-purposed for this work.

### Track 1: vp-remove-allow-home
- **Area**: backend
- **Branch**: `vp-remove-allow-home`
- **Objective**: Drop `VP_ALLOW_HOME` and let `vp analyze` read image paths anywhere on the local filesystem by default; delegate permission enforcement to the OS sandbox (for example nono).
- **Scope & Files**: `src/core.ts` (`isPathAllowed` + `homeRoot`), `src/core.test.ts`, hook/integration tests, `src/cli.ts` (help text), `README.md`, `AGENTS.md`, `docs/SETUP.md`.
- **Tasks**:
  - [ ] Remove the `VP_ALLOW_HOME` branch from `isPathAllowed` in `src/core.ts`
  - [ ] Update the home-path error message to drop `VP_ALLOW_HOME` references
  - [ ] Rewrite tests that asserted home paths are denied
  - [ ] Update README, AGENTS, docs/SETUP, and CLI help text
  - [ ] Run `npm test && npm run typecheck && fallow audit`
- **Verification**: `npm test && npm run typecheck && fallow audit`
- **Depends On**: none

## Tools / MCP / Skills

- `agents-docs` for plan tracking.
- `review-gate` before merging.
- Native tools: `git`, `wt`, `pnpm`, `fallow`.

## Risks

- **Behavior change.** Existing users who relied on the default home-deny behavior will now have home paths accepted.
- **Test churn.** Tests that assert home paths are denied need to be rewritten.
- **Sandbox assumption.** This change assumes the deployment environment uses an OS sandbox to restrict sensitive paths.
