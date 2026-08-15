---
type: plan
title: fix pi uninstall message
description: "Fix `vp integration uninstall pi` reporting 'was not installed' on first uninstall even though the extension file is removed."
area: backend
tags: [cli, integration, bug, pi, uninstall]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ../qa/backend-post-merge-qa-for-pr-5.md
  - ../worktrees/backend-fix-pi-uninstall-message.md
  - ../plans/backend-cli-distribution-strategy.md
---
# fix pi uninstall message

## Goal capsule

Make `vp integration uninstall pi` print the correct success message on the first run, instead of "pi integration was not installed", when the Pi extension file exists and is actually removed.

## Current state (grounded)

- `src/commands/integration.ts` `integrationUninstall()` decides its message from the `removed` flag.
- For the `pi` agent, `configPath()` returns `""`, so the `if (cfgPath && existsSync(cfgPath))` block is skipped entirely and `removed` stays `false`.
- The target extension file (`~/.pi/agent/extensions/vision-proxy.ts`) is still deleted via `rmSync(target)`, but the final branch keys off `removed`, so Pi always hits the wrong message: `${agent} integration was not installed`.
- History: a fix was attempted in `c8852cc` then **reverted** on `main` in `0031fd0`. Branch `fix/pi-uninstall-message` (origin) still carries the fix but was never merged. The existing `worktrees/backend-fix-pi-uninstall-message.md` doc is stale - it marks tasks done, but the tip was reverted, so the bug is still live on `main`.

## Target state

- `vp integration install pi && vp integration uninstall pi` prints `uninstalled pi integration (removed <path>)`.
- A regression test in `src/commands/integration.test.ts` asserts the correct message after install + uninstall of the `pi` agent.

## Key technical decisions

| ID | Decision | Rationale |
|----|----------|----------|
| D1 | Set `removed = true` once the target file is successfully `rmSync`'d (not only when a host config block is removed). | Pi has no host config, so the existing `removed` assignment never fires for it; file deletion is the real signal. |
| D2 | Keep `pi` as a no-host-config agent (`configPath() = ""`) - do not invent a config file just to satisfy the flag. | Minimal change; the `removed` semantics should reflect file-or-config removal generically. |
| D3 | Re-derive `removed` from both signals: `removed = fileDeleted || configRemoved`. | Makes the message correct for hook agents too and avoids future regressions. |

## Deliverables

1. Edit `integrationUninstall` in `src/commands/integration.ts` to set/derive `removed` correctly.
2. Add a regression test in `src/commands/integration.test.ts` covering `pi` install + uninstall message.
3. Run `npm test`, `npm run typecheck`, and `fallow audit` clean.
4. Reconcile the stale `worktrees/backend-fix-pi-uninstall-message.md` doc (flip its tasks back to open / mark needing redo) and open the PR.

## Worktree Strategy

- **Branch:** `fix/pi-uninstall-message` (off `main`); existing branch on origin can be reused after reconciling the revert.
- **Area:** backend.
- **Objective:** Correct the uninstall success message for the `pi` agent and lock it with a regression test.
- **Tasks:**
  - [ ] Re-apply the corrected `removed` logic in `integrationUninstall`.
  - [ ] Add regression test asserting `uninstalled pi integration` after `pi` install + uninstall.
  - [ ] Run `npm test`, `npm run typecheck`, `fallow audit`.
  - [ ] Open PR and merge to `main`.
- **Verification:** `vp integration install pi && vp integration uninstall pi` prints the uninstall confirmation; 141+ tests pass.
- **Stacking:** Phase 2, wave 1 of batch `vp-qa-fixes`. `depends_on` phase 1 worktrees: bug fixes (`backend-prune-max-tool-calls-per-turn.md`, `backend-fix-pi-extension-typebox-dependency.md`) and tooling (`backend-tooling-biome-betterleaks.md`). `fix/hook-shim-shared-mjs` (plan `backend-fix-hook-shim-shared-mjs-copy.md`) stacks on this branch (position 2 within the batch) because both fixes edit `src/commands/integration.ts`. Runs concurrently with the phase 2 `vp-distribution` batch.

## Risks / open questions

- Ensure the wording change does not break the existing `vp integration status` / `list` outputs (separate commands).
- The `mode` config key (QA finding #2) is unrelated and must NOT be deleted here - it is still a supported key.
