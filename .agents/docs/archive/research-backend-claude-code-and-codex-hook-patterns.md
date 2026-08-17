---
type: research
title: claude code and codex hook patterns
description: Compare destructive_command_guard and herdr hook implementations to decide how vision-proxy should wire UserPromptSubmit and PreToolUse Read(image_path) hooks.
area: backend
tags: []
status: complete
superseded_by: ../plans/backend-add-pretooluse-read-hook.md
created: "2026-08-16"
updated: "2026-08-16"
sources:
  - https: //github.com/Dicklesworthstone/destructive_command_guard
  - https: //github.com/ogulcancelik/herdr
  - local: /home/tys203831/Documents/Coding/vision-proxy/.worktrees/dev/src/commands/integration.ts
  - local: /home/tys203831/.opensrc/repos/github.com/ogulcancelik/herdr/master/src/integration/mod.rs
  - local: /home/tys203831/.opensrc/repos/github.com/Dicklesworthstone/destructive_command_guard/main/scripts/e2e_codex.sh
stale_after: "2026-09-15"
related:
  - ../bugs/backend-claude-code-and-codex-hooks-not-working.md
  - ../archive/backend-vision-proxy-hook-shims.md
  - ../archive/plan-backend-binary-as-hook-vision-proxy-integration.md
  - https: //github.com/Dicklesworthstone/destructive_command_guard
  - https: //github.com/ogulcancelik/herdr
---
# claude code and codex hook patterns

## Question

How do destructive_command_guard and herdr implement Claude Code and Codex hooks, and which patterns should vision-proxy adopt for `UserPromptSubmit` and `PreToolUse Read(image_path)` hooks?

## Summary of findings

| # | Finding | Relevance | Confidence | Evidence |
|---|---------|-----------|------------|----------|
| 1 | Both Claude Code and Codex support `UserPromptSubmit` and `PreToolUse` command hooks configured in `~/.claude/settings.json` and `~/.codex/config.toml` / `~/.codex/hooks.json`. | critical | high | local:/home/tys203831/.opensrc/repos/github.com/ogulcancelik/herdr/master/src/integration/mod.rs |
| 2 | herdr registers many lifecycle hooks (`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`) for pane-state reporting, but its hook scripts are herdr-specific and exit early unless `HERDR_ENV=1`. | normal | medium | local:/home/tys203831/.opensrc/repos/github.com/ogulcancelik/herdr/master/src/integration/assets/claude/herdr-agent-state.sh |
| 3 | destructive_command_guard uses only `PreToolUse` (matched to the `Bash` tool) to intercept shell commands and deny destructive ones; it emits a `hookSpecificOutput` JSON with `permissionDecision`. | critical | high | local:/home/tys203831/.opensrc/repos/github.com/Dicklesworthstone/destructive_command_guard/main/scripts/e2e_codex.sh |
| 4 | Current vision-proxy installs only a `UserPromptSubmit` Node.js shim for both Claude Code and Codex; it does not install a `PreToolUse` hook. | critical | high | local:/home/tys203831/Documents/Coding/vision-proxy/.worktrees/dev/src/commands/integration.ts |
| 5 | PreToolUse receives `toolInput` (e.g., `{"command":"..."}` for Bash, `{"file_path":"..."}` for Read) and can respond with `hookSpecificOutput.permissionDecision` or `additionalContext`. | normal | high | local:/home/tys203831/.opensrc/repos/github.com/Dicklesworthstone/destructive_command_guard/main/src/hook.rs |
| 6 | Codex uses a separate `hooks.json` file for hook configuration, while Claude Code stores hooks inside `settings.json`; both expect a command invoked with the hook event JSON on stdin. | normal | high | local:/home/tys203831/.opensrc/repos/github.com/ogulcancelik/herdr/master/src/integration/mod.rs |

## Findings

### Current vision-proxy hook implementation

`src/commands/integration.ts` installs:

- **Claude Code**: writes `claude-code-vision-proxy-user-prompt-submit.mjs` and `shared.mjs` next to the `vp` binary, then registers a `UserPromptSubmit` command hook in `~/.claude/settings.json` that runs `node <shim>`.
- **Codex**: writes `codex-vision-proxy-user-prompt-submit.mjs` and `shared.mjs`, then appends a `[[UserPromptSubmit]]` block to `~/.codex/config.toml`.

Both shims import `./shared.mjs`, extract image paths from `event.prompt`, shell out to `vp analyze`, and emit `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":...}}`.

There is no `PreToolUse` hook installed today (verified-by: local:/home/tys203831/Documents/Coding/vision-proxy/.worktrees/dev/src/commands/integration.ts). If the agent reads an image file via a tool call rather than mentioning a path in its prompt, vision-proxy does not intercept it.

### herdr's hook pattern

herdr's integration installer (`src/integration/mod.rs`) supports Claude, Codex, Pi, OpenCode, and Hermes. For Claude and Codex it:

- Installs a shell script (`herdr-agent-state.sh`) into `~/.claude/hooks/` or `~/.codex/`.
- Registers multiple command hooks: `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`, and `SessionEnd`.
- Each hook entry calls `bash <hook> <action>` with a timeout of 10 seconds.
- The hook script reads the JSON event from stdin, checks that `HERDR_ENV=1` is set, and reports pane state to a Unix socket.

This confirms that multiple hook types can share one script and that both Claude Code and Codex accept command hooks that read stdin and optionally write JSON.

### destructive_command_guard's hook pattern

DCG is a Rust CLI that runs as a `PreToolUse` command hook. Its E2E harness (`scripts/e2e_codex.sh`) writes a minimal `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "<dcg binary>"
          }
        ]
      }
    ]
  }
}
```

DCG reads the JSON event from stdin, extracts the Bash command from `toolInput.command`, evaluates it, and emits either nothing (allow) or `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` (deny). The same binary handles the wire-protocol differences between Claude Code and Codex internally.

### Implications for vision-proxy

To satisfy the constraint of using only `UserPromptSubmit` and `PreToolUse Read(image_path)` hooks:

1. Keep the existing `UserPromptSubmit` shim for prompt-time image paths.
2. Add a `PreToolUse` shim that matches the `Read` tool, inspects `toolInput.file_path`, and if the path is an image, runs `vp analyze` and returns the description as `additionalContext`.
3. For Codex, register the `PreToolUse` hook in `~/.codex/hooks.json` (or `config.toml`'s `[[PreToolUse]]` block if supported); for Claude Code, add it to `~/.claude/settings.json`.
4. The shim must detect which hook event fired (`UserPromptSubmit` vs `PreToolUse`) and produce the correct `hookSpecificOutput` shape for each.

## Recommendation

Adopt a single shared shim (or extend the existing `shared.mjs`) that:

- Reads `event.hook_event_name` / `event.hookEventName`.
- For `UserPromptSubmit`: extracts image paths from `event.prompt` and emits `additionalContext`.
- For `PreToolUse` when `event.tool_name === "Read"` and the file is an image: runs `vp analyze <file>` and emits `additionalContext`.
- For all other cases: exits 0 with no output (fail-open).

Update `vp integration install claude-code|codex` to register both hook types.

## Open questions

- Does Codex honor `[[PreToolUse]]` blocks in `config.toml`, or must hooks be registered in `hooks.json`?
- Does Claude Code's `settings.json` support a `matcher` field for `PreToolUse` to limit it to the `Read` tool, or will it fire on every tool use?
- Should the `PreToolUse` hook return `permissionDecision: allow` plus `additionalContext`, or only `additionalContext`?

## Sources

- local:/home/tys203831/Documents/Coding/vision-proxy/.worktrees/dev/src/commands/integration.ts
- local:/home/tys203831/Documents/Coding/vision-proxy/.worktrees/dev/src/shims/claude-code-user-prompt-submit.mjs
- local:/home/tys203831/Documents/Coding/vision-proxy/.worktrees/dev/src/shims/codex-user-prompt-submit.mjs
- local:/home/tys203831/Documents/Coding/vision-proxy/.worktrees/dev/src/shims/shared.mjs
- local:/home/tys203831/.opensrc/repos/github.com/ogulcancelik/herdr/master/src/integration/mod.rs
- local:/home/tys203831/.opensrc/repos/github.com/ogulcancelik/herdr/master/src/integration/assets/claude/herdr-agent-state.sh
- local:/home/tys203831/.opensrc/repos/github.com/ogulcancelik/herdr/master/src/integration/assets/codex/herdr-agent-state.sh
- local:/home/tys203831/.opensrc/repos/github.com/Dicklesworthstone/destructive_command_guard/main/scripts/e2e_codex.sh
- local:/home/tys203831/.opensrc/repos/github.com/Dicklesworthstone/destructive_command_guard/main/src/hook.rs
