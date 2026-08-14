---
type: worktree
title: Vision proxy hook shims
description: Implement per-agent hook install tooling and Claude Code + Codex UserPromptSubmit shims for the vision proxy CLI.
area: backend
tags: [worktree, hooks, claude-code, codex, vision]
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-08-28"
related:
  - ../plans/backend-migrate-vision-proxy-to-vercel-ai-sdk-cli-driven-by-agent-userpromptsubmit-hooks.md
  - backend-vision-proxy-cli-core
---

# Vision proxy hook shims

## Objective

Provide thin, per-agent `UserPromptSubmit` hook shims that detect images in a user prompt, shell out to `vp analyze`, and inject the fenced description as additional context.

## Scope

- Implement the `hook` subcommand:
  - `hook install <agent>`
  - `hook show <agent>`
  - `hook list`
  - `hook uninstall <agent>`
- Build a Claude Code shim that parses the `UserPromptSubmit` JSON, extracts image paths, runs `vp analyze`, and prints `additionalContext`.
- Build a Codex CLI shim using the equivalent `UserPromptSubmit` hook contract, respecting the ~2500-token output budget and fail-open timeout behavior.
- End-to-end test: real image path through `vp analyze`, then through a Claude Code `UserPromptSubmit` hook, confirming the fenced description lands as additional context.
- Document the install flow for both agents.

## Branch

- Worktree branch: `vp-hook-shims`
- Base branch: `configurable-analyze-image-limit`
- Depends on: `vp-cli-core` (needs the `vp` binary and the `analyze` output contract).

## Verification

- `/review-gate` (medium-high risk — touches agent config files and per-agent behavior).

## Status

active
