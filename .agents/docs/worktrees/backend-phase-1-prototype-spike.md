---
type: worktree
title: "Phase 1: Prototype spike"
description: "Phase 1: Prototype spike - implementation track for add pretooluse read hook."
area: backend
tags: []
status: active
created: "2026-08-17"
updated: "2026-08-18"
stale_after: "2026-08-31"
branch: feat/add-pretooluse-read-hook
pr_strategy: combined
combined_with:
  - feat/add-pretooluse-read-hook-impl
review_worktree: qa/vp-hook
stack_position: 1
stack_batch: hook
related: [../plans/backend-add-pretooluse-read-hook.md]
---
# Phase 1: Prototype spike

## Objective

Validate that a minimal `vp hook` binary can inject `additionalContext` into both Claude Code and Codex model context before committing to the full install/uninstall rewrite.

## Scope

- Build a throwaway `vp hook` that emits a fake `additionalContext` string.
- Temporarily wire it into `src/cli.ts`.
- Manually install the hook in Claude Code and Codex.
- Test `UserPromptSubmit` and `PreToolUse Read` events.
- Record pass/fail results.

## Tasks

- [x] Create a throwaway `vp hook` prototype in `src/commands/hook.ts` that emits a static/fake `additionalContext` string (no real `vp analyze` call yet).
- [x] Wire it temporarily into `src/cli.ts`.
- [x] Manually install the hook in Claude Code `~/.claude/settings.json` with the absolute `vp` path.
- [x] Manually install the hook in Codex `~/.codex/hooks.json` with the absolute `vp` path.
- [x] Test `UserPromptSubmit`: submit a prompt mentioning an image path; verify the fake context appears in the agent's context.
- [x] Test `PreToolUse Read`: ask the agent to read an image file; verify the fake context appears before/after the tool result.
- [x] Record results in a QA dossier or update this plan.

## Verification

- `npm test`: 157 pass / 0 fail in `qa/vp-hook` merge preview.
- `npm run typecheck`: pass.
- `fallow audit --gate-marker agent`: pass.

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [x] Landed on feature branch (ready for PR/merge)

## QA notes

Prototype validated that a `vp hook` binary can inject `additionalContext` into both Claude Code and Codex.
The branch was merged into `qa/vp-hook` and is combined with `feat/add-pretooluse-read-hook-impl` for a single PR.
PR: https://github.com/tan-yong-sheng/vision-proxy/pull/12 (branch `feat/add-pretooluse-read-hook-pr`).
