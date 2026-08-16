---
type: plan
title: Binary-as-hook vision-proxy integration
description: Replace shim scripts with a `vp analyze --hook` entry point so Claude Code and Codex hooks invoke the CLI binary directly.
area: backend
tags: [cli, hooks, claude-code, codex, pretooluse, integration, binary-as-hook]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-10-15"
related:
  - ../archive/research-backend-binary-as-hook-vision-proxy-integration.md
---
# Binary-as-hook vision-proxy integration

## Goal capsule

Eliminate the Node.js shim scripts and `shared.mjs` sidecar. `vp integration install claude-code|codex` will register the `vp` binary itself as the hook command, handling both `UserPromptSubmit` and `PreToolUse(Read image)` events internally.

## Current state

- `src/shims/*.mjs` and `src/shims/shared.mjs` implement the hook protocol.
- `scripts/copy-shims.mjs` copies shims to `dist/shims/` at build time.
- `vp integration install` writes a shim + sidecar to an install directory and registers `node <shim-path>` in the agent config.
- The default install directory falls back to the CLI's `dist/shims/`, which is unexpected and fragile.
- The current hook only handles `UserPromptSubmit`, so Claude Code can still issue `Read(image.png)` and fail on text-only models.

## Target state

- A new `vp analyze --hook` mode (or `vp hook` subcommand) reads a hook event from stdin and emits the agent-specific JSON response.
- The mode handles:
  - `UserPromptSubmit`: extract image paths from `prompt`, analyze them, return `additionalContext`.
  - `PreToolUse`: if `tool_name === "Read"` and `tool_input.file_path` is an image, deny the read and return `additionalContext` with the `vp analyze` output.
- `vp integration install claude-code` writes only `~/.claude/settings.json` entries:
  - `UserPromptSubmit` hook: `"command": "vp analyze --hook"`
  - `PreToolUse` hook: `"matcher": "Read"`, `"command": "vp analyze --hook"`
- `vp integration install codex` writes only `~/.codex/config.toml` entries:
  - `[[UserPromptSubmit.hooks]]` with `command = "vp analyze --hook"`
  - `[[PreToolUse]]` with `matcher = "Read"` and `command = "vp analyze --hook"`
- Shim files and `shared.mjs` are removed from source and build output.
- `scripts/copy-shims.mjs` is deleted.
- The old hook research doc is archived and superseded by this plan.

## Key technical decisions

1. **Entry point shape.** Use `vp analyze --hook` rather than a new top-level subcommand. It keeps the public command surface small and makes the intent clear: analyze images, but invoked as a hook.
2. **No shim fallback.** Once the binary-as-hook mode works, remove the shim path entirely. Maintaining both creates drift and doubles the test surface.
3. **PATH assumption.** The hook command is `vp analyze --hook`, which requires `vp` to be on PATH when the agent runs. For non-PATH installs, add `--vp-bin <path>` to `vp integration install` so it writes the absolute path.
4. **Fail-open.** On any error (no image found, analyze failure, malformed event), the hook emits an empty/no-op response and exits 0 so the agent proceeds unchanged.
5. **Image detection in `PreToolUse`.** Match `tool_name === "Read"` and a file path ending in a known image extension. Use the same extension list as the legacy shim.
6. **Keep both `UserPromptSubmit` and `PreToolUse` hooks.** `UserPromptSubmit` proactively injects descriptions before the agent decides what to do; `PreToolUse(Read image)` reactively blocks direct image reads on text-only models. They are not redundant because they cover different failure modes. The overlap is cheap because `vp analyze` caches results by image hash.
6. **Config file locations.** Keep using `~/.claude/settings.json` and `~/.codex/config.toml` as the default config targets; no shim files means no install directory decision.

## Deliverables

| # | Deliverable | File(s) | Verification |
|---|---|---|---|
| 1 | Add `vp analyze --hook` flag and hook event handler | `src/commands/analyze.ts`, `src/cli.ts` | `vp analyze --hook < event.json` returns correct JSON |
| 2 | Implement `UserPromptSubmit` branch | `src/commands/analyze.ts` | Unit test with sample event |
| 3 | Implement `PreToolUse(Read image)` branch | `src/commands/analyze.ts` | Unit test denies Read and injects context |
| 4 | Update Claude Code installer | `src/commands/integration.ts` | Config block uses `vp analyze --hook` |
| 5 | Update Codex installer | `src/commands/integration.ts` | TOML block uses `vp analyze --hook` |
| 6 | Remove shim files and build step | `src/shims/*.mjs`, `scripts/copy-shims.mjs`, `package.json` scripts | `pnpm run build` succeeds without shim copy |
| 7 | Delete shim tests / migrate to hook-mode tests | `src/shims/*.e2e.mjs`, `src/commands/integration.test.ts` | `pnpm test` passes |
| 8 | Add `--vp-bin` install option | `src/cli.ts`, `src/commands/integration.ts` | `vp integration install claude-code --vp-bin /path/to/vp` writes absolute path |
| 9 | Update README and AGENTS docs | `README.md`, `AGENTS.md` | Docs describe binary-as-hook install |
| 10 | Archive outdated hook research | `.agents/docs/archive/research-backend-hook-based-tool-interception-for-vision-proxy.md` | Status set to `superseded_by` this plan |

## Worktree Strategy

Single worktree: `backend-binary-as-hook`.

- The change is tightly coupled across `analyze`, `integration`, CLI wiring, and tests.
- It depends on PR #6 landing first because it touches the same files (`src/commands/integration.ts`, `src/commands/analyze.ts`, build scripts).

### Worktree

- **Area**: backend
- **Branch**: `backend-binary-as-hook`
- **Base**: `main` (after PR #6 merges)
- **Status**: active
- **Objective**: Replace shim-based hooks with `vp analyze --hook` binary-as-hook integration.
- **Scope & files**: `src/commands/analyze.ts`, `src/commands/integration.ts`, `src/cli.ts`, `src/shims/`, `scripts/copy-shims.mjs`, `package.json`, `src/commands/integration.test.ts`, `README.md`, `AGENTS.md`.
- **Verification**: `pnpm install && pnpm run build && pnpm test && pnpm run typecheck && fallow audit`
- **Depends on**: PR #6 merge

## Tools / MCP / Skills

- `agents-docs` for research and plan tracking.
- `worktrunk-orca-delegation` if the user wants to delegate implementation.
- `review-gate` before merging.
- Native tools: `git`, `wt`, `pnpm`, `fallow`, `no-mistakes`.

## Risks

1. **PATH dependency.** If `vp` is not on PATH when Claude Code/Codex runs, the hook silently fails. Mitigate with `--vp-bin` and clear install-time validation.
2. **Schema drift.** Claude Code's exact `PreToolUse` schema is not published as formally as Codex's. Mitigate by supporting both `permissionDecision: "deny"` and the legacy block format, and test against the latest Claude Code.
3. **Breaking existing installs.** Users who installed shim-based hooks will have stale shim files. `vp integration uninstall` should clean them up, and `vp integration install` should overwrite the config blocks.
4. **No-op behavior.** If the hook emits invalid JSON on failure, the agent may error. Ensure fail-open responses are always valid JSON.
