---
type: worktree
title: resolve claude image refs
description: Worktree for resolving Claude Code `[Image #N]` prompt refs to image-cache file paths analyzed by `vp hook`.
area: backend
tags: [claude-code, hooks, image-cache]
status: active
created: "2026-08-23"
updated: "2026-08-23"
stale_after: "2026-09-06"
related:
  - ../plans/backend-resolve-claude-image-refs.md
---

# resolve claude image refs

## Goal

Resolve Claude Code `[Image #N]` prompt references to their on-disk image-cache
file paths so `vp hook`'s `UserPromptSubmit` handler analyzes pasted/attached
images, then commit the branch.

## Branch

`feat/hook-claude-image-refs` (worktree at
`/home/tys203831/Documents/Coding/vision-proxy/.worktrees/feat-hook-claude-image-refs`).

## Tools / MCP / Skills

- Native: read, edit, bash
- Skills: agents-docs

## Tasks

- [x] Confirm Claude Code's real image-cache path (`<config>/image-cache/<session_id>/<N>.<ext>`) from leaked source.
- [x] Live-verify by pasting an image into this session: `~/.claude/image-cache/38646690-0fba-4b89-b9a7-fca771e606ea/1.png` created (valid 555x602 PNG, perms `600`).
- [x] Implement `resolveImageRefs(prompt, sessionId)` in `src/commands/hook.ts` (read-only, fail-open, multi-extension probe).
- [x] Wire into `UserPromptSubmit` branch of `runHook`; honor `CLAUDE_CONFIG_DIR` / `VP_CLAUDE_CONFIG_DIR`.
- [x] Add 3 unit tests in `src/commands/hook.test.ts`.
- [x] Document mapping in `src/cli.ts` `vp hook --help`.
- [x] Full test suite: 389 pass / 0 fail; `tsc --noEmit` clean.
- [ ] Review and commit the branch.

## Verification

- `node --experimental-strip-types --test src/commands/hook.test.ts`: 3 resolver tests pass (empty refs, cached-file resolution, end-to-end emit).
- Full suite (`node ... --test src/*.test.ts src/**/*.test.ts`): 389 pass, 0 fail.
- `npx tsc --noEmit`: exit 0.
- Live check: pasted image present at the resolved path; `resolveImageRefs` would return that absolute path for prompt `[Image #1]` with the running `session_id`.

## Open questions

- Does a different Claude Code build (not v2.1.239) store pasted images elsewhere? Live-verified only on this machine's bundled v2.1.239.
- Directory listing perms are world-readable (`drwxrwxr-x`); the file is `600`. Confirmed Claude Code behavior, acceptable.
