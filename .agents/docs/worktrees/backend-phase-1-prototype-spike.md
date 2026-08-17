---
type: worktree
title: "Phase 1: Prototype spike"
description: "Phase 1: Prototype spike - implementation track for add pretooluse read hook."
area: backend
tags: []
status: active
created: "2026-08-17"
updated: "2026-08-17"
stale_after: "2026-08-31"
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

- [ ] Create a throwaway `vp hook` prototype in `src/commands/hook.ts` that emits a static/fake `additionalContext` string (no real `vp analyze` call yet).
- [ ] Wire it temporarily into `src/cli.ts`.
- [ ] Manually install the hook in Claude Code `~/.claude/settings.json` with the absolute `vp` path.
- [ ] Manually install the hook in Codex `~/.codex/hooks.json` with the absolute `vp` path.
- [ ] Test `UserPromptSubmit`: submit a prompt mentioning an image path; verify the fake context appears in the agent's context.
- [ ] Test `PreToolUse Read`: ask the agent to read an image file; verify the fake context appears before/after the tool result.
- [ ] Record results in a QA dossier or update this plan.

## Verification

npm test

## Status

- [ ] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
