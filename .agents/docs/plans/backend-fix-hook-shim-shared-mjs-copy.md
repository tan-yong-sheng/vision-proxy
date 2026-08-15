---
type: plan
title: fix hook shim shared mjs copy
description: "Fix Claude Code / Codex hook install writing a shim that imports a missing ./shared.mjs, causing an ESM resolve error at hook runtime."
area: backend
tags: [cli, integration, bug, hook, shim, claude-code, codex]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ../qa/backend-post-merge-qa-for-pr-5.md
  - ../plans/backend-cli-distribution-strategy.md
---
# fix hook shim shared mjs copy

## Goal capsule

Ensure `vp integration install claude-code|codex` always ships `shared.mjs` next to the generated hook shim, so the installed UserPromptSubmit hook does not fail at runtime with `node:internal/modules/esm/resolve` when it imports `./shared.mjs`.

## Current state (grounded)

- `integrationInstall()` in `src/commands/integration.ts` copies the shared shim with:
  ```ts
  const sharedSrc = join(shimDir(), "shared.mjs");
  if (existsSync(sharedSrc)) {
    writeFileSync(join(dirname(target), "shared.mjs"), readFileSync(sharedSrc));
  }
  ```
- `shimDir()` resolves to `dist/shims` when the built CLI runs. `scripts/copy-shims.mjs` copies every non-`e2e` `.mjs` from `src/shims` into `dist/shims`, so `dist/shims/shared.mjs` normally exists - but if the build is stale, skipped, or changed, that file can be absent.
- When `dist/shims/shared.mjs` is missing, the `if (existsSync(sharedSrc))` guard is silently false, the copy is skipped, and the installed shim still does `import ... from "./shared.mjs"` - which does not exist at the install location -> ESM resolve error the first time the hook fires.
- `shimDir()`'s fallback candidates end at `join(here, "..", "shims")` but none of them verify that `shared.mjs` actually exists there, so the resolver can return a directory without the file.

## Target state

- `vp integration install claude-code` (and `codex`) reliably writes `shared.mjs` beside the shim, even from a built `dist/` whose `shared.mjs` was somehow not copied.
- If `shared.mjs` cannot be resolved from any candidate location, the install fails loudly with a clear error instead of producing a broken shim.
- A regression e2e test installs a hook agent into a temp dir and asserts `shared.mjs` exists next to the generated shim and that the shim's import resolves.

## Key technical decisions

| ID | Decision | Rationale |
|----|----------|----------|
| D1 | Resolve `shared.mjs` via a fallback chain: `shimDir()` result -> `src/shims` (repo source) -> error. | The source dir always has `shared.mjs`; using it as a guaranteed fallback removes the stale-build gap. |
| D2 | Hard-fail install when no `shared.mjs` candidate exists, rather than skipping the copy. | Silent skip is the root cause of the runtime ESM error; failing fast surfaces the problem at install time. |
| D3 | Keep `copy-shims.mjs` copying `shared.mjs`, but treat a missing `src/shims/shared.mjs` as a build error. | Build should never ship without it; fail the build rather than the user's hook. |
| D4 | Embed the install-time `vp` path into the hook shim, with a runtime fallback to `vp` via PATH. | Removes the need for `VP_BIN`/`VISION_PROXY_PATH` env vars; works for both curl (`~/.local/bin/vp`) and Homebrew symlinks. |

## Deliverables

1. Add a `resolveSharedShim()` helper in `src/commands/integration.ts` implementing the fallback chain (D1) and throwing when none resolve (D2).
2. Use it in `integrationInstall()` for the `sharedShim` copy (replace the silent `if (existsSync)` guard).
3. Tighten `scripts/copy-shims.mjs` to error if `src/shims/shared.mjs` is absent.
4. Add an e2e regression test (e.g. `src/shims/*.e2e.mjs` or `src/commands/integration.test.ts`) asserting `shared.mjs` lands next to the installed shim.
5. Update `src/shims/shared.mjs` to use an embedded `__VP_PATH_PLACEHOLDER__` (set at install time) instead of `process.env.VP_BIN || "vp"`, with a PATH fallback.
6. Run `npm test`, `npm run typecheck`, `fallow audit` clean.

## Worktree Strategy

- **Branch:** `fix/hook-shim-shared-mjs` (stacks on `fix/pi-uninstall-message`).
- **Area:** backend.
- **Objective:** Make hook-agent install robust to missing `shared.mjs` and fail loudly instead of shipping a broken shim.
- **Tasks:**
  - [ ] Implement `resolveSharedShim()` with `dist/shims` -> `src/shims` fallback + throw-on-missing.
  - [ ] Wire it into `integrationInstall()`.
  - [ ] Harden `copy-shims.mjs`.
  - [ ] Add e2e regression test.
  - [ ] Run `npm test`, `npm run typecheck`, `fallow audit`.
  - [ ] Open PR and merge to `main`.
- **Verification:** Install claude-code into a temp dir, assert `shared.mjs` present and the shim's import resolves; full `npm test` green.
- **Stacking:** Phase 2, wave 2 of batch `vp-qa-fixes`. `depends_on` the `backend-fix-pi-uninstall-message` worktree and the phase 1 worktrees: bug fixes (`backend-prune-max-tool-calls-per-turn.md`, `backend-fix-pi-extension-typebox-dependency.md`) and tooling (`backend-tooling-biome-betterleaks.md`). #4 rebases on #1's tip to avoid a cross-worktree conflict in `src/commands/integration.ts`. Runs concurrently with the phase 2 `vp-distribution` batch.

## Risks / open questions

- Must keep `shimDir()` working in both built (`dist/`) and dev (`src/`) contexts; the fallback to `src/shims` must not break the dev path.
- Cross-platform path handling for the temp install dir in the e2e test (use `mkdtemp`).
- This is coupled to the distribution work: whatever install layout (npm, Homebrew, GitHub release) is chosen, the shim + `shared.mjs` must travel together (see `backend-cli-distribution-strategy.md`).
