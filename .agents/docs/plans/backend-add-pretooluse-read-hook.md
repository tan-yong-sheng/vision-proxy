---
type: plan
title: add pretooluse read hook
description: Add PreToolUse Read(image_path) hooks for Claude Code and Codex so vision-proxy intercepts image reads via tool calls.
area: backend
tags: []
status: active
created: "2026-08-16"
updated: "2026-08-17"
stale_after: "2026-10-15"
entry_point: true
related:
  - ../archive/research-backend-claude-code-and-codex-hook-patterns.md
  - ../research/backend-codex-pretooluse-hook-feasibility-confirmation.md
  - ../research/backend-claude-code-hook-feasibility-openclaude-confirmation.md
  - ../bugs/backend-claude-code-and-codex-hooks-not-working.md
  - ../archive/backend-vision-proxy-hook-shims.md
  - ../archive/backend-vision-proxy-shared-shim.md
visual: .lavish/backend-add-pretooluse-read-hook-plan.html
---
# add pretooluse read hook

## Goal capsule

Make `vp integration install claude-code|codex` register both a `UserPromptSubmit` hook (existing) and a `PreToolUse Read(image_path)` hook, so vision-proxy describes images whether the agent mentions a path in its prompt or reads an image file via a tool call.

## Current state

- vision-proxy installs a `UserPromptSubmit` Node.js shim (`claude-code-user-prompt-submit.mjs` / `codex-user-prompt-submit.mjs`) plus a `shared.mjs` sidecar for both Claude Code and Codex.
- The shim extracts image paths from `event.prompt`, shells out to `vp analyze`, and emits `additionalContext`.
- There is no `PreToolUse` hook today, so reading an image via the `Read` tool bypasses vision-proxy.
- The `.mjs` + `shared.mjs` sidecar pattern has already caused a runtime failure where the sidecar was missing.
- The reference projects and prior art are analyzed in ../archive/research-backend-claude-code-and-codex-hook-patterns.md.

## Target state

1. Add a new `vp hook` subcommand that reads the agent's hook event JSON from stdin and dispatches:
   - `UserPromptSubmit`: extract image paths from `event.prompt`, run `vp analyze`, emit `additionalContext`.
   - `PreToolUse` with `tool_name === "Read"` and an image `file_path`: run `vp analyze`, emit `additionalContext`.
   - All other cases: exit 0 with no output (fail-open).
2. `vp integration install claude-code` registers both hook types in `~/.claude/settings.json` with command `"<absolute-vp-path> hook"`.
3. `vp integration install codex` registers both hook types in `~/.codex/hooks.json` with command `"<absolute-vp-path> hook"`.
4. `vp integration uninstall` removes both hook registrations cleanly.
5. `vp integration status` reports both hooks per agent.
6. The `.mjs` shim files and `shared.mjs` copy logic are removed.

### Sample installed hook configs

**Claude Code - `~/.claude/settings.json`:**

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/user/.local/share/vision-proxy/v0.2.0/vp hook",
            "timeout": 30
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "/home/user/.local/share/vision-proxy/v0.2.0/vp hook",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

**Codex - `~/.codex/hooks.json`:**

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/user/.local/share/vision-proxy/v0.2.0/vp hook",
            "timeout": 30
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "/home/user/.local/share/vision-proxy/v0.2.0/vp hook",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

`vp hook` reads stdin JSON, inspects `hook_event_name` and `tool_name`, and emits `{"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}` for both Claude Code and Codex. Both agents send hook input in snake_case (`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`) and expect hook output in camelCase (`hookSpecificOutput.hookEventName`).

## `vp hook` routing and content extraction sketch

This is how `vp hook` turns image inputs into text context for a text-input-only model.

```text
stdin JSON
    |
    v
parse hook_event_name / hookEventName
    |
    +-- UserPromptSubmit ----> extract image paths from event.prompt
    |                            |
    |                            v
    |                        run `vp analyze <path> [<path> ...]`
    |                            |
    |                            v
    |                        emit additionalContext with fenced description
    |
    +-- PreToolUse -----------> check tool_name / toolName == "Read"
                                 |
                                 +-- yes -> inspect tool_input.file_path
                                 |            |
                                 |            +-- image extension? -> run `vp analyze <file_path>`
                                 |            |                       |
                                 |            |                       v
                                 |            |                   emit additionalContext
                                 |            |
                                 |            +-- not an image? -> exit 0 (no-op)
                                 |
                                 +-- no -> exit 0 (no-op)
```

### Image path extraction rules

For `UserPromptSubmit`, reuse the regex passes from the current `shared.mjs`:

1. **Pi-clipboard temp files**: paths matching `pi-clipboard-<uuid>.<ext>`.
2. **Absolute paths**: paths starting with `/`, `~/`, `C:\`, etc., ending in a known image extension.
3. **Relative paths**: paths starting with `./` or `../` and ending in a known image extension.
4. **Known extensions**: `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `tiff`, `tif`, `ico`, `avif`.

For `PreToolUse Read`, the Read tool's input is expected to be `{"file_path": "..."}`. `vp hook` checks:

- `tool_name` equals `"Read"`.
- `tool_input` is an object with a `file_path` string.
- `file_path` ends with a known image extension.
- (Defensive fallback: if `file_path` is missing but `path` is present, treat `path` as the file path.)

If all match, that single file is analyzed. No text extraction is needed because the Read tool already provides the exact file path.

### Routing to a text-input-only model

`vp analyze` sends the image(s) to the configured vision model and prints a fenced, UNTRUSTED text description. `vp hook` captures that text and returns it as `additionalContext` in the hook output JSON. The agent's underlying LLM never receives the binary image; it only sees the generated description as system context. This is the existing vision-proxy value proposition, now extended from prompt-time mentions to Read-tool interception.

### Sample `vp hook` payloads

Both agents send input in snake_case and expect output in camelCase. The output shape is identical for Claude Code and Codex.

#### Claude Code `UserPromptSubmit` input

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "sess_abc123",
  "transcript_path": "/Users/me/.claude/transcripts/...",
  "cwd": "/Users/me/project",
  "permission_mode": "default",
  "prompt": "What is in /Users/me/project/screenshot.png?"
}
```

#### Codex `UserPromptSubmit` input

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "sess_xyz789",
  "transcript_path": "/Users/me/.codex/transcripts/...",
  "cwd": "/Users/me/project",
  "permission_mode": "default",
  "model": "o3",
  "agent_id": "agent_001",
  "agent_type": "default",
  "prompt": "What is in /Users/me/project/screenshot.png?"
}
```

#### Claude Code `PreToolUse Read` input

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "sess_abc123",
  "transcript_path": "/Users/me/.claude/transcripts/...",
  "cwd": "/Users/me/project",
  "permission_mode": "default",
  "tool_name": "Read",
  "tool_use_id": "tu_001",
  "tool_input": {
    "file_path": "/Users/me/project/screenshot.png"
  }
}
```

#### Codex `PreToolUse Read` input

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "sess_xyz789",
  "transcript_path": "/Users/me/.codex/transcripts/...",
  "cwd": "/Users/me/project",
  "permission_mode": "default",
  "model": "o3",
  "agent_id": "agent_001",
  "agent_type": "default",
  "tool_name": "Read",
  "tool_use_id": "tu_001",
  "tool_input": {
    "file_path": "/Users/me/project/screenshot.png"
  }
}
```

#### Output for both agents (UserPromptSubmit and PreToolUse)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[vision-proxy] UNTRUSTED description of /Users/me/project/screenshot.png: A browser window showing ..."
  }
}
```

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "[vision-proxy] UNTRUSTED description of /Users/me/project/screenshot.png: A browser window showing ..."
  }
}
```

No other top-level fields are emitted. `continue` defaults to `true`, `decision` is absent, and `permissionDecision` is absent, so the agent proceeds unchanged and the Read tool runs with its original input.

### Fail-open behavior

- If stdin cannot be parsed as JSON, exit 0.
- If the event type is unrecognized, exit 0.
- If no image paths are found, exit 0.
- If `vp analyze` fails or times out, log to stderr and exit 0.
- In all cases, the agent proceeds unchanged when vision-proxy cannot contribute.

## Key technical decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Implement a single `vp hook` subcommand instead of extending the `.mjs` shims | Removes the `shared.mjs` sidecar dependency, reduces install complexity, and matches the prior binary-as-hook plan and dcg's proven pattern |
| D2 | Match `PreToolUse` to the `Read` tool only | Matches the user's constraint to scope hooks to `UserPromptSubmit` and `PreToolUse Read(image_path)` |
| D3 | Emit `additionalContext` for both hook types rather than `permissionDecision` | vision-proxy is additive (adds descriptions), not gating (deny/allow), so a permission decision would be misleading |
| D4 | Write the absolute `vp` path into the hook command at install time | Avoids depending on `vp` being on the agent's PATH; works for curl, Homebrew, and npm installs |
| D5 | Use `~/.codex/hooks.json` for Codex hooks instead of `config.toml` | herdr and destructive_command_guard both use `hooks.json` for Codex hooks; it supports tool-specific `matcher` fields and is easier to parse/merge than TOML blocks |

## Tools / MCP / Skills

- Native: read, edit, bash
- Skills: agents-docs

## Deliverables

- New `src/commands/hook.ts` implementing the `vp hook` subcommand.
- Updated `src/cli.ts` to wire `vp hook`.
- Updated `src/commands/integration.ts` to register/uninstall/status both hook types using the absolute `vp` path.
- Removed `src/shims/*.mjs` files and `scripts/copy-shims.mjs` build step.
- Tests for `vp hook` output shapes and `vp integration` install/uninstall round-trips.

## Worktree Strategy

Single worktree. Branch: `feat/add-pretooluse-read-hook`.

The work is split into two phases so we validate end-to-end hook injection before committing to the full install/uninstall rewrite.

### Phase 1: Prototype spike

Goal: prove `additionalContext` from a minimal `vp hook` binary actually reaches the model in both Claude Code and Codex.

- [ ] Create a throwaway `vp hook` prototype in `src/commands/hook.ts` that emits a static/fake `additionalContext` string (no real `vp analyze` call yet).
- [ ] Wire it temporarily into `src/cli.ts`.
- [ ] Manually install the hook in Claude Code `~/.claude/settings.json` with the absolute `vp` path.
- [ ] Manually install the hook in Codex `~/.codex/hooks.json` with the absolute `vp` path.
- [ ] Test `UserPromptSubmit`: submit a prompt mentioning an image path; verify the fake context appears in the agent's context.
- [ ] Test `PreToolUse Read`: ask the agent to read an image file; verify the fake context appears before/after the tool result.
- [ ] Record results in a QA dossier or update this plan.

If the spike fails, reassess the architecture before Phase 2.

### Phase 2: Full implementation

- [x] Validate Claude Code uses `~/.claude/settings.json` for hooks and supports `matcher` on `PreToolUse` (source: https://claude.com/blog/how-to-configure-hooks and https://code.claude.com/docs/en/hooks).
- [x] Cross-check Claude Code hook shapes against the OpenClaude fork: input uses snake_case (`hook_event_name`, `tool_name`, `tool_input`, `prompt`), output uses camelCase `hookSpecificOutput.hookEventName`, Read tool input is `file_path`, matcher `"Read"` is exact match, and `additionalContext` is injected as a meta user message (source: ../research/backend-claude-code-hook-feasibility-openclaude-confirmation.md).
- [x] Validate Codex uses `~/.codex/hooks.json`, supports `matcher` on `PreToolUse`, and accepts `additionalContext` in `hookSpecificOutput` (source: https://developers.openai.com/codex/hooks, local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/schema/generated/*.schema.json, and local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/core/src/hook_runtime.rs).
- [x] Confirm Codex `Read` tool input uses `tool_input.file_path` (source: local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/engine/mcp_runner_tests.rs and local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/engine/discovery.rs).
- [ ] Implement production `src/commands/hook.ts` with real `vp analyze` dispatch for `UserPromptSubmit` / `PreToolUse Read`.
- [ ] Wire `vp hook` into `src/cli.ts`.
- [ ] Update `src/commands/integration.ts` `claudeCode` spec to register/uninstall/status both hook types with absolute `vp` path.
- [ ] Update `src/commands/integration.ts` `codex` spec to use `~/.codex/hooks.json` and register/uninstall/status both hook types; also remove any legacy `config.toml` `[[UserPromptSubmit]]` block on install/uninstall.
- [ ] Remove `src/shims/*.mjs` and `scripts/copy-shims.mjs`; update build scripts.
- [ ] Update `vp integration status` to report both hooks per agent.
- [ ] Add unit tests for `vp hook` output and integration install/uninstall round-trips.
- [ ] Run the full manual verification against Claude Code and Codex after the installer is updated.

## Risks / open questions

- [x] Claude Code supports `matcher` on `PreToolUse`; validated via official docs.
- [x] Codex `hooks.json` supports `matcher` and `additionalContext`; validated via official docs and the codex-rs JSON schemas.
- [x] Codex `Read` tool input field is `tool_input.file_path`; validated via codex-rs test fixtures and template strings.
- [x] Codex injects `additionalContext` as developer-role messages; validated via `codex-rs/core/src/hook_runtime.rs`.
- [x] Claude Code hook input/output schemas and Read tool shape are consistent with the proposed plan; cross-checked against the OpenClaude fork and official docs.
- [ ] Removing the `.mjs` shim files is a breaking change for users who customized them; document the migration.
- [ ] Adding a second hook doubles the `vp analyze` invocation surface; ensure `vp hook` still fail-opens on any error.
- [ ] The absolute `vp` path written at install time can become stale after a version update; `vp integration status` should flag this and `vp integration install` should refresh it.
- [x] Legacy Codex `config.toml` blocks: current `src/commands/integration.ts` (Codex `apply`) appends a `[[UserPromptSubmit]]` block with the `vision-proxy` marker to `~/.codex/config.toml`. The new installer must remove any such block when migrating to `~/.codex/hooks.json`. This only affects users who previously ran `vp integration install codex`; fresh installs are unaffected.
- [x] The Codex `PreToolUse` input schema has `tool_input` typed as `true` (any JSON); `vp hook` must defensively check for `file_path` (and optionally `path`) before treating it as a Read call.
- [ ] End-to-end proof that `additionalContext` is surfaced to both agents' models requires a live prototype spike.

## Research notes on risks

| Risk | Research finding | Resolution |
|------|------------------|------------|
| Codex `additionalContext` injection | Confirmed via `codex-rs/core/src/hook_runtime.rs` that `additionalContext` strings are converted to developer-role messages and injected with `inject_if_running`. | High confidence in architecture; low confidence without live prototype. |
| Claude Code `additionalContext` injection | Confirmed via OpenClaude `src/utils/messages.ts` that hook `additionalContext` is pushed as a meta user message. | High confidence in architecture; low confidence without live prototype. |
| Legacy Codex `config.toml` block | Current `src/commands/integration.ts` (Codex `apply`) appends a `[[UserPromptSubmit]]` block with the `vision-proxy` marker to `~/.codex/config.toml`. The new installer must remove it defensively. | Update `codex` integration spec to remove legacy blocks during install/uninstall. |
| Absolute `vp` path becomes stale | The current code already writes the absolute `vp` path into `shared.mjs`; the new design does the same directly in the hook command. Other tools (e.g., herdr, dcg) use the same pattern. | Acceptable; mitigate via `vp integration status` flagging outdated paths and `vp integration install` refreshing them. |
| Removing `.mjs` shims breaks customizers | Any user who edited `src/shims/*.mjs` will lose customizations. | Document migration: custom logic should be moved to a wrapper script or contributed upstream. |
| `tool_input` schema is `any JSON` | Both agents send `tool_input` as arbitrary JSON. The Read tool uses `file_path`; the hook should fall back to `path` and validate the value is a string before analysis. | Implemented defensively in `vp hook`. |
| Read tool passes relative paths | Unknown. The hook receives `cwd` in the input and should resolve relative paths against it. | Implement path resolution in `vp hook` using `cwd`. |

## Open questions

- Will a live Codex CLI actually surface the injected developer message to the model, or does it require a specific model / version? A prototype spike is needed.
- Will a live Claude Code CLI surface the injected meta user message to the model? A prototype spike is needed.
- Does the Codex `Read` tool ever pass a relative path in `tool_input.file_path`, or is it always absolute? The hook should resolve relative paths against `cwd` defensively.
- Are there edge cases where `tool_input` contains `path` instead of `file_path` for a tool whose matcher happens to match `"Read"`? The hook should treat both keys as fallbacks.
