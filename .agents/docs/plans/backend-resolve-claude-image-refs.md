---
type: plan
title: resolve claude image refs
description: Resolve Claude Code `[Image #N]` prompt refs to absolute image-cache file paths so `vp hook` can analyze pasted/attached images.
area: backend
tags: [claude-code, hooks, image-cache, userpromptsubmit]
status: active
created: "2026-08-23"
updated: "2026-08-23"
stale_after: "2026-10-22"
entry_point: false
related:
  - ../plans/backend-add-pretooluse-read-hook.md
  - ../worktrees/backend-resolve-claude-image-refs.md
---

# resolve claude image refs

## Goal capsule

Extend `vp hook`'s `UserPromptSubmit` handling so that images a user pastes into
Claude Code (rendered as `[Image #N]` in the prompt) are resolved to their
on-disk file paths and analyzed by `vp analyze`, exactly like image paths the
user types out by hand.

## Current state (grounded)

- `src/commands/hook.ts` already extracts absolute/relative image paths from
  `event.prompt` via `extractImagePaths` and analyzes them. But it does not
  understand Claude Code's `[Image #N]` reference syntax, so pasted images are
  invisible to vision-proxy.
- Claude Code stores pasted/attached images under a session-scoped cache and
  renders them in the prompt as `[Image #N]`. This was confirmed two ways this
  session:
  1. Leaked Claude Code source (`src/utils/imageStore.ts`) shows the store
     path `join(getClaudeConfigHomeDir(), 'image-cache', getSessionId())` with
     `getClaudeConfigHomeDir()` returning `process.env.CLAUDE_CONFIG_DIR ??
     join(homedir(), '.claude')`.
  2. Live verification on this machine: after pasting an image into a session
     (`session_id = 38646690-0fba-4b89-b9a7-fca771e606ea`), Claude Code created
     `~/.claude/image-cache/38646690-0fba-4b89-b9a7-fca771e606ea/1.png` - a valid
     555x602 RGB PNG (`file` magic `89 50 4E 47`, perms `-rw-------`). The
     directory name is the exact `session_id` that appears 14 times in
     `~/.claude/history.jsonl` for the running session.
- The `UserPromptSubmit` hook input carries that `session_id`
  (`createBaseHookInput` sets `session_id: resolvedSessionId`), so the resolver
  has the key it needs.

## Target state

1. `vp hook` resolves `[Image #N]` refs in `event.prompt` to
   `<CLAUDE_CONFIG_DIR | ~/.claude>/image-cache/<session_id>/<N>.<ext>` and adds
   the existing files to the set analyzed for the `UserPromptSubmit` event.
2. Missing/unknown refs are skipped so the hook fails open (never blocks a
   prompt on a stale ref).
3. The config home honors `CLAUDE_CONFIG_DIR` (as Claude Code does) and falls
   back to `~/.claude`; overridable via `VP_CLAUDE_CONFIG_DIR` for tests and
   non-standard installs.
4. `vp hook --help` documents the `[Image #N]` mapping.

### Verified storage mechanism

```
~/.claude/image-cache/
└── <session_id>/          # == UserPromptSubmit event.session_id
    └── <N>.<ext>          # [Image #N] -> <N>.<ext> (ext from media type, default png)
```

- Created on demand when an image is pasted (`ensureImageStoreDir` + `storeImage`).
- File written binary, perms `0o600`; dir perms from default umask (`drwxrwxr-x`
  on this machine - the directory listing is world-readable, the file is not).
- Self-cleaned: `cleanupOldImageCaches()` deletes other sessions' cache dirs on
  each new session, keeping only the current session's. So a ref is only
  resolvable during the session it was pasted in - which is exactly when the
  hook runs.

## Key technical decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Read-only resolution via `existsSync` + path join | vision-proxy must never create or mutate Claude Code's cache; fail-open on missing files |
| D2 | Key off `event.session_id` (snake_case, plus `event.sessionId` fallback) | Matches the leaked source's `createBaseHookInput` field name and Claude Code's snake_case hook input |
| D3 | Fall back to `~/.claude` unless `CLAUDE_CONFIG_DIR` is set | Mirrors Claude Code's own config-home resolution exactly |
| D4 | Allow `VP_CLAUDE_CONFIG_DIR` override | Lets tests point the resolver at a temp cache and supports installs that redirect `CLAUDE_CONFIG_DIR` |
| D5 | Try multiple image extensions per id | The cache file extension comes from the media type; probing a small extension list avoids needing to parse media metadata |

## Tools / MCP / Skills

- Native: read, edit, bash
- Skills: agents-docs

## Deliverables (implemented on `feat/hook-claude-image-refs`)

- `src/commands/hook.ts`: `resolveImageRefs(prompt, sessionId)` plus wiring into
  the `UserPromptSubmit` branch (merges ref-resolved paths with
  `extractImagePaths` output). Imports `existsSync`, `homedir`.
- `src/commands/hook.test.ts`: three tests - empty refs / no session, cached
  file resolution (png + jpg, missing id, de-dup), and end-to-end
  `UserPromptSubmit` emit.
- `src/cli.ts`: `vp hook --help` documents the `[Image #N]` mapping.
- Verification: full suite 389 pass, 0 fail; `tsc --noEmit` clean.

## Worktree Strategy

Single worktree. Branch: `feat/hook-claude-image-refs`.

- Active flight log: `../worktrees/backend-resolve-claude-image-refs.md`.
- The implementation is complete in the worktree; the plan is the design record
  and dispatch contract. Remaining step is review + commit on the branch.

### Tasks

- [x] Confirm Claude Code's real image-cache path from source + live paste on this machine.
- [x] Implement `resolveImageRefs` (read-only, fail-open, ext probing).
- [x] Wire into `UserPromptSubmit` branch of `runHook`.
- [x] Honor `CLAUDE_CONFIG_DIR` / `VP_CLAUDE_CONFIG_DIR`.
- [x] Add unit tests; full suite green; typecheck clean.
- [x] Document mapping in `vp hook --help`.
- [ ] Review and commit the branch (`feat/hook-claude-image-refs`).

## Risks / open questions

- [x] Path correctness: confirmed against leaked source AND a live paste on this machine.
- [x] `session_id` availability in the hook event: confirmed via `createBaseHookInput`.
- [x] File is the decoded binary image (valid PNG), not base64 text - `vp analyze` can read it directly.
- [x] Cache self-cleans between sessions - but the hook runs within the active session, so refs resolve when they matter.
- [ ] Version drift: v2.1.239 is a bundled ELF; the leaked `codeaashu/claude-code` source may not match exactly. The live-paste verification on this same machine is the stronger evidence, but a different Claude Code build could store elsewhere.
- [ ] Directory listing perms are world-readable (`drwxrwxr-x`) while the file is `600`. The image content is private; only the listing leaks filenames. This is Claude Code's behavior, not vision-proxy's, and is acceptable.

## Related

- Parent design: ../plans/backend-add-pretooluse-read-hook.md
- Active worktree log: ../worktrees/backend-resolve-claude-image-refs.md
