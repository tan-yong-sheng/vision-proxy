---
type: research
title: Codex PreToolUse hook feasibility confirmation
description: Deep-dive confirmation that Codex CLI hooks can route PreToolUse Read calls through a single binary hook that emits additionalContext.
area: backend
tags: [codex, hooks, pretooluse, vision-proxy]
status: active
created: "2026-08-16"
updated: "2026-08-17"
sources:
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/schema/generated/user-prompt-submit.command.output.schema.json
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/events/pre_tool_use.rs
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/events/user_prompt_submit.rs
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/core/src/hook_runtime.rs
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/core/src/context/hook_additional_context.rs
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/engine/mcp_runner_tests.rs
  - local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/engine/discovery.rs
  - https://developers.openai.com/codex/hooks
stale_after: "2026-09-15"
related:
  - ../plans/backend-add-pretooluse-read-hook.md
  - ../bugs/backend-claude-code-and-codex-hooks-not-working.md
  - ../archive/research-backend-claude-code-and-codex-hook-patterns.md
---
# Codex PreToolUse hook feasibility confirmation

## Question

Can the proposed `vp hook` binary serve as a Codex `PreToolUse` hook for the `Read` tool, emit `additionalContext` that the Codex CLI injects into the model context, and do so without blocking or mutating the original tool call?

## Summary of findings

| # | Finding | Relevance | Confidence | Evidence |
|---|---------|-----------|------------|----------|
| 1 | Codex hooks are configured in `~/.codex/hooks.json` and support `UserPromptSubmit` and `PreToolUse` events. | critical | high | local:codex-rs/hooks/schema/generated/*.schema.json, https://developers.openai.com/codex/hooks |
| 2 | A `PreToolUse` hook receives JSON on stdin containing `tool_name`, `tool_input`, `tool_use_id`, `cwd`, transcript path, and session metadata. | critical | high | local:codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json, local:codex-rs/hooks/src/events/pre_tool_use.rs |
| 3 | The `Read` tool passes its target path in `tool_input.file_path`. | critical | high | local:codex-rs/hooks/src/engine/mcp_runner_tests.rs (fixtures with `{"tool_input":{"file_path":"/tmp/example.rs"}}`), local:codex-rs/hooks/src/engine/discovery.rs |
| 4 | Context-only hooks should emit `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"..."}}` and omit `permissionDecision` and `updatedInput`. | critical | high | local:codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json, local:codex-rs/hooks/src/engine/output_parser.rs |
| 5 | Codex injects `additionalContext` strings as developer-role messages before the tool result is processed. | critical | high | local:codex-rs/core/src/hook_runtime.rs (`additional_context_messages`, `record_additional_contexts`), local:codex-rs/core/src/context/hook_additional_context.rs |
| 6 | Tool-name matchers are regexes, so `"^Read$"` (or the bare string `"Read"`) matches the Read tool. | normal | high | local:codex-rs/hooks/src/engine/discovery.rs, local:codex-rs/hooks/src/events/pre_tool_use.rs |
| 7 | The `async` hook flag exists but is unnecessary for a context-only hook; synchronous execution is the default. | normal | medium | local:codex-rs/hooks/src/engine/output_parser.rs, local:codex-rs/core/src/hook_runtime.rs |
| 8 | No live prototype has been run, so end-to-end proof that additionalContext is actually surfaced to the model remains unvalidated. | critical | low | none |

## Findings

### Codex hook configuration surface

Codex CLI reads hooks from `~/.codex/hooks.json`. The top-level object contains a `hooks` map keyed by event name. Each event maps to an array of matcher entries; each entry has an optional `matcher` regex and an array of `hooks` to run. This matches the shape already sketched in ../plans/backend-add-pretooluse-read-hook.md and the prior art from herdr and destructive_command_guard.

### PreToolUse input shape

The `PreToolUse` hook receives a JSON object on stdin. The canonical fields are:

- `session_id`
- `turn_id`
- `subagent` (optional context for thread-spawn subagents)
- `cwd`
- `transcript_path`
- `model`
- `permission_mode`
- `tool_name` (canonical tool name)
- `matcher_aliases` (array of compatibility names used only for matching)
- `tool_use_id`
- `tool_input` (arbitrary JSON, the tool's arguments)

For the `Read` tool, fixtures and templating in the codex-rs source use `tool_input.file_path` as the path key. This is the value `vp hook` should inspect.

### Output shape for a context-only hook

The output schema for `PreToolUse` commands permits a top-level `decision` of `approve` or `block`, plus `hookSpecificOutput` containing:

- `hookEventName`: must be `"PreToolUse"`
- `additionalContext`: optional string, emitted into model context
- `permissionDecision`: optional `allow` / `deny` / `ask`
- `permissionDecisionReason`: optional string
- `updatedInput`: optional arbitrary JSON

For a hook that only adds a vision description, the safe minimal output is:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "[vision-proxy] UNTRUSTED description of /path/to/image.png: ..."
  }
}
```

Omitting `permissionDecision` and `updatedInput` keeps the hook additive and avoids accidentally gating or mutating the Read call.

### How additionalContext reaches the model

`codex-rs/core/src/hook_runtime.rs` collects `additional_contexts` from hook outcomes and converts each string into a `HookAdditionalContext` value. That value implements `ContextualUserFragment` with role `"developer"` and no markers. The resulting `ResponseItem`s are injected into the running session via `inject_if_running`. Therefore, a `PreToolUse` hook's `additionalContext` becomes a developer message in the conversation before the tool result is processed, exactly analogous to the `UserPromptSubmit` case.

### Matchers and tool selection

The Codex hook matcher field is a regex applied to the canonical tool name (and optionally matcher aliases). The Read tool is canonically named `"Read"`, so a matcher of `"^Read$"` or simply `"Read"` will match. The current plan's proposed `"matcher": "Read"` is feasible.

### Synchronous vs asynchronous execution

Codex hooks support `async: true` to run without blocking tool execution. For a context-only hook, blocking synchronously is acceptable because the model cannot proceed until the description is available anyway. The default synchronous mode is the right choice for `vp hook` until profiling proves otherwise.

## Open questions

- Will a live Codex CLI actually surface the injected developer message to the model, or does it require a specific model / version? A prototype spike is needed.
- Does the Codex `Read` tool ever pass a relative path in `tool_input.file_path`, or is it always absolute? The hook should resolve relative paths against `cwd` defensively.
- Are there edge cases where `tool_input` contains `path` instead of `file_path` for a tool whose matcher happens to match `"Read"`? The hook should treat both keys as fallbacks.

## Sources

- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json
- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json
- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/schema/generated/user-prompt-submit.command.output.schema.json
- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/events/pre_tool_use.rs
- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/events/user_prompt_submit.rs
- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/core/src/hook_runtime.rs
- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/core/src/context/hook_additional_context.rs
- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/engine/mcp_runner_tests.rs
- local:/home/tys203831/.opensrc/repos/github.com/openai/codex/main/codex-rs/hooks/src/engine/discovery.rs
- https://developers.openai.com/codex/hooks
