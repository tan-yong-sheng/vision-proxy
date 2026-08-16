---
type: research
title: Binary-as-hook vision-proxy integration
description: "Investigate whether vision-proxy can register the `vp` binary itself as a Claude Code/Codex hook command, eliminating the Node.js shim scripts and shared.mjs sidecar."
area: backend
tags:
  - cli
  - hooks
  - claude-code
  - codex
  - pretooluse
  - integration
  - binary-as-hook
status: complete
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-09-15"
superseded_by: ../plans/backend-binary-as-hook-vision-proxy-integration.md
related: [../plans/backend-binary-as-hook-vision-proxy-integration.md]
---
# Binary-as-hook vision-proxy integration

## Question

Can `vp integration install claude-code|codex` register the `vp` binary itself as the hook command, instead of copying a Node.js shim script and `shared.mjs` sidecar?

Specifically:

- Do Claude Code and Codex allow arbitrary executables as hook commands?
- What are the exact input/output JSON schemas for `UserPromptSubmit` and `PreToolUse`?
- Can a single `vp analyze --hook` entry point handle both events and emit the correct response shape?
- What are the trade-offs vs. the current shim-script approach?

## Findings

### 1. Both agents allow arbitrary executables as hook commands

**Claude Code**
- Hook config lives in `~/.claude/settings.json` (global) or `.claude/settings.json` / `.claude/settings.local.json` (project-local).
- A hook entry is `{ "type": "command", "command": "<any shell command>", "timeout": N }`.
- The command receives JSON on stdin and must print the response JSON to stdout.
- Non-managed hooks require user review/trust before they run.

**Codex**
- Hook config lives in `~/.codex/config.toml`, `~/.codex/hooks.json`, `.codex/config.toml`, or `.codex/hooks.json`.
- A hook entry is `type = "command"`, `command = "<any shell command>"`, `timeout = N`.
- Official examples place scripts under `.codex/hooks/` (project-local) or `~/.codex/hooks/` (global).
- Non-managed hooks must be reviewed and trusted via the `/hooks` command before they run.

### 2. Current vision-proxy shim design

Today `vp integration install claude-code` does two things:

1. Writes a shim file (e.g. `claude-code-vision-proxy-user-prompt-submit.mjs`) and a `shared.mjs` sidecar to the install directory.
2. Adds a `UserPromptSubmit` hook to `~/.claude/settings.json` that runs `node <shim-path>`.

The shim parses the hook event, extracts image paths from the prompt, shells out to `vp analyze`, and emits JSON output. This design predates confirmed `PreToolUse` support and uses a shim because `vp analyze` only accepts image paths as CLI args and prints plain text.

### 3. Claude Code events

Claude Code fires at least these relevant events:

- `UserPromptSubmit` - once per user turn, before the model processes it.
- `PreToolUse` - before every tool call; can block or modify it.
- `PostToolUse` - after every tool call.

The documented output for `UserPromptSubmit` is:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<vision_proxy_description image=\"...\">...</vision_proxy_description>"
  }
}
```

The documented output for `PreToolUse` is:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Image routed through vision-proxy",
    "additionalContext": "<vision_proxy_description image=\"...\">...</vision_proxy_description>",
    "updatedInput": { }
  }
}
```

Claude Code also supports a legacy block-by-exit-code-2 mode, but the JSON decision mode is preferred for returning `additionalContext`.

### 4. Codex events (exact schemas from openai/codex)

Codex supports the same events. The generated JSON schemas in `codex-rs/hooks/schema/generated/` confirm the wire formats.

**UserPromptSubmit input:**

```json
{
  "agent_id": "...",
  "agent_type": "...",
  "cwd": "...",
  "hook_event_name": "UserPromptSubmit",
  "model": "...",
  "permission_mode": "default",
  "prompt": "user text here",
  "session_id": "...",
  "transcript_path": "...",
  "turn_id": "..."
}
```

**UserPromptSubmit output:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

**PreToolUse input:**

```json
{
  "agent_id": "...",
  "agent_type": "...",
  "cwd": "...",
  "hook_event_name": "PreToolUse",
  "model": "...",
  "permission_mode": "default",
  "session_id": "...",
  "tool_input": { ... },
  "tool_name": "Read",
  "tool_use_id": "...",
  "transcript_path": "...",
  "turn_id": "..."
}
```

**PreToolUse output:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "...",
    "additionalContext": "...",
    "updatedInput": null
  }
}
```

Codex also accepts a legacy top-level `{ "decision": "block", "reason": "..." }` format, but the `hookSpecificOutput` shape is the forward-compatible one.

### 5. Feasibility of `vp analyze --hook`

A single binary entry point is feasible. It would:

1. Read JSON from stdin.
2. Branch on `hook_event_name`:
   - `UserPromptSubmit`: extract image paths from `prompt`, analyze them, emit `additionalContext`.
   - `PreToolUse`: if `tool_name === "Read"` and `tool_input.file_path` is an image, emit `permissionDecision: "deny"` plus `additionalContext`; otherwise emit no-op/allow.
3. Internally call the existing analyze logic (no shell-out to itself).

This would let `vp integration install claude-code` write:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "vp analyze --hook", "timeout": 60 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "vp analyze --hook", "timeout": 60 }
        ]
      }
    ]
  }
}
```

And similarly for Codex:

```toml
[[UserPromptSubmit.hooks]]
type = "command"
command = "vp analyze --hook"
timeout = 60

[[PreToolUse]]
matcher = "Read"
[[PreToolUse.hooks]]
type = "command"
command = "vp analyze --hook"
timeout = 60
```

### 6. Trade-offs

| Approach | Pros | Cons |
|---|---|---|
| **Binary-as-hook (`vp analyze --hook`)** | No shim files to copy/version; no `shared.mjs`; hook config is a one-liner; survives `vp` upgrades automatically. | Requires `vp` on PATH when Claude/Codex runs; harder to override `vp` path per hook; slightly larger `vp` binary surface. |
| **Current shim scripts** | Shim embeds absolute `vp` path at install time; works even if `vp` is not on PATH; keeps hook logic separate from CLI binary. | Needs `shared.mjs` sidecar; shim can be deleted/overwritten; install path defaults to project `dist/shims/` instead of agent hooks dir; version drift between shim and CLI. |

### 7. Recommendation

Build `vp analyze --hook` and switch the integration installer to use the binary directly.

Rationale:

- It removes the shim/shared.mjs machinery entirely, which is the source of the current install-path bugs.
- It aligns with the user's expectation that the CLI binary itself can be a hook command.
- It makes `vp integration install` idempotent and robust: only the agent config file changes.
- The `vp` binary is already the distribution artifact; relying on it being on PATH is reasonable for a globally installed CLI.

For environments where `vp` is not on PATH, support an explicit `--vp-bin` install flag or env var that embeds the absolute path in the hook command, e.g. `"command": "/opt/vp analyze --hook"`.

## Open questions

- Should `vp analyze --hook` be a separate subcommand (e.g. `vp hook`) instead of a flag, to keep the analyze surface clean?
- What is the exact `PreToolUse` input schema for Claude Code? The Codex schema is authoritative for Codex; Claude Code's may differ in field names.
- Does Claude Code require `permissionDecision` lowercase (`deny`) or does it accept `block`? Docs show `deny`; we should test.
- For project-local installs, should we use `${CLAUDE_PROJECT_DIR}` or `~/.claude/hooks/` as the default? The binary-as-hook approach makes this moot because no shim file is written.
- How does `vp analyze --hook` behave when no image is found? It should emit an empty no-op response so the agent proceeds unchanged.
