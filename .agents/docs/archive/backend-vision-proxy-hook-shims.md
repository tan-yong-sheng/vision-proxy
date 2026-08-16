---
type: worktree
title: Vision proxy hook shims
description: Implement per-agent hook install tooling and Claude Code + Codex UserPromptSubmit shims for the vision proxy CLI.
area: backend
tags: [worktree, hooks, claude-code, codex, vision]
status: landed
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

landed

## Implementation

The `hook` subcommand and the per-agent shims were implemented in this worktree on top of the `vp` CLI core (merged from `vp-cli-core`).

### Commands

```
vp hook install <agent>      # claude-code | codex
vp hook show <agent>        # print shim + config block for manual install
vp hook list                # show installed shims (per-agent configs)
vp hook uninstall <agent>
```

`install` copies the matching shim from `src/shims/` to `dist/shims/` (next to the `vp` binary) and edits the agent config:
- **claude-code**: `~/.claude/settings.json` gains a `hooks.UserPromptSubmit[].hooks[]` entry with `type: "command"`, `command: "node <shim>"`, `timeout: 30`.
- **codex**: `~/.codex/config.toml` gains a `[[UserPromptSubmit]]` -> `[[UserPromptSubmit.hooks]]` with `type = "command"`, the same node command, `timeout = 30`, and `additionalContextLimit = 4096`.

`uninstall` rewrites the config to drop only the vision-proxy block (matched by a `vision-proxy` marker), leaving other hooks intact, and removes the copied shim file.

### Shims

- `src/shims/claude-code-user-prompt-submit.mjs` - reads the `UserPromptSubmit` event JSON from stdin, extracts image paths from the prompt (porting the Pi extension's `extractCandidateImagePaths` regexes), shells out to `vp analyze <images>`, and prints `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<fenced description>"}}`.
- `src/shims/codex-user-prompt-submit.mjs` - identical flow but passes `--max-output-tokens 2000` (overridable via `VP_MAX_OUTPUT_TOKENS`) so the description fits inside Codex's default ~2500-token preview; emits the same `hookSpecificOutput.additionalContext` shape.

Both shims enforce a 30s timeout (`VP_HOOK_TIMEOUT_MS`) and **fail open**: on missing `vp`, no API key, timeout, or non-zero exit they write a note to stderr and exit 0 with no stdout, so the agent proceeds unchanged. Image-derived text is attacker-controlled, so the safety fence from `vp analyze` stays on by default and is never stripped.

### Install flow (either agent)

1. Build + install the CLI: `pnpm install && pnpm build`, then `npm link` (or `pnpm link --global`) so `vp` is on PATH.
2. `vp hook install claude-code` (and/or `vp hook install codex`).
3. Confirm with `vp hook list`.
4. To inspect before editing: `vp hook show claude-code` prints the shim path plus the exact config block for manual paste.

### Verification

- `pnpm test` covers the cli-core suite, the hook command (install/show/list/uninstall against an isolated temp HOME), and an end-to-end Claude Code hook test that pipes a real image path through the shim and asserts the fenced description lands as `additionalContext`.
- `pnpm exec tsc --noEmit` typechecks.
