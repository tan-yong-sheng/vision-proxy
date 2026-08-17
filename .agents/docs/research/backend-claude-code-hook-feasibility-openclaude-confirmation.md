---
type: research
title: Claude Code hook feasibility OpenClaude confirmation
description: Cross-reference the OpenClaude fork against the proposed vp hook binary plan to confirm Claude Code PreToolUse/UserPromptSubmit hook shapes and behavior.
area: backend
tags: [claude-code, hooks, openclaude, pretooluse, vision-proxy]
status: active
created: "2026-08-16"
updated: "2026-08-17"
sources:
  - local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/schemas/hooks.ts
  - local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/types/hooks.ts
  - local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/entrypoints/sdk/coreTypes.generated.ts
  - local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/utils/hooks.ts
  - local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/utils/messages.ts
  - local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/tools/FileReadTool/constants.ts
  - local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/tools/FileReadTool/FileReadTool.ts
  - https://code.claude.com/docs/en/hooks
  - https://claude.com/blog/how-to-configure-hooks
stale_after: "2026-09-15"
related:
  - ../plans/backend-add-pretooluse-read-hook.md
  - ../bugs/backend-claude-code-and-codex-hooks-not-working.md
  - ../archive/research-backend-claude-code-and-codex-hook-patterns.md
---
# Claude Code hook feasibility OpenClaude confirmation

## Question

Does the OpenClaude fork confirm the hook shapes and runtime behavior assumed in ../plans/backend-add-pretooluse-read-hook.md for the official Claude Code CLI? Specifically: the settings file location, the `PreToolUse`/`UserPromptSubmit` input/output schemas, the `Read` tool input field, matcher semantics, and how `additionalContext` is injected into the conversation.

## Summary of findings

| # | Finding | Relevance | Confidence | Evidence |
|---|---------|-----------|------------|----------|
| 1 | OpenClaude uses hook config files `~/.openclaude/settings.json` and `.openclaude/settings.json`, not `.claude/settings.json`. | normal | high | local:openclaude/main/web/src/data/configuration.ts, local:openclaude/main/src/utils/permissions/filesystem.ts |
| 2 | The hook config schema is a map of event name -> array of `{matcher?: string, hooks: HookCommand[]}`. | critical | high | local:openclaude/main/src/schemas/hooks.ts (`HooksSchema`, `HookMatcherSchema`) |
| 3 | `matcher` supports exact string, pipe-separated list, or regex. `"Read"` matches the Read tool exactly. | critical | high | local:openclaude/main/src/utils/hooks.ts (`matchesPattern`) |
| 4 | `PreToolUse` input uses snake_case: `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, plus session metadata. | critical | high | local:openclaude/main/src/entrypoints/sdk/coreTypes.generated.ts (`PreToolUseHookInput`) |
| 5 | `UserPromptSubmit` input uses snake_case: `hook_event_name`, `prompt`, plus session metadata. | critical | high | local:openclaude/main/src/entrypoints/sdk/coreTypes.generated.ts (`UserPromptSubmitHookInput`) |
| 6 | Hook output JSON uses camelCase `hookSpecificOutput.hookEventName`. For `PreToolUse` it may include `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext`. For `UserPromptSubmit` it includes `additionalContext`. | critical | high | local:openclaude/main/src/types/hooks.ts (`syncHookResponseSchema`) |
| 7 | The Read tool canonical name is `"Read"` and its input schema requires `file_path: string`. | critical | high | local:openclaude/main/src/tools/FileReadTool/constants.ts (`FILE_READ_TOOL_NAME = 'Read'`), local:openclaude/main/src/tools/FileReadTool/FileReadTool.ts (`file_path: z.string()`) |
| 8 | `additionalContext` from a hook is injected as a user message with `isMeta: true`. | critical | high | local:openclaude/main/src/utils/messages.ts (`createUserMessage({ content: response.hookSpecificOutput.additionalContext, isMeta: true })`) |
| 9 | OpenClaude is a third-party fork/leaked codebase, not the official current Claude Code CLI. The findings are consistent with official Claude Code docs but should be validated on the real CLI. | critical | medium | none |

## Findings

### Source reliability

OpenClaude (`Gitlawb/openclaude`) is a VS Code extension based on a previously leaked Claude Code codebase. It is not the official Claude Code CLI, but its hook types, schemas, and runtime logic are substantially the same as the documented Claude Code hook system. I used it as a reference to inspect concrete code paths (stdin JSON shape, matcher logic, Read tool schema, and additionalContext injection) that the official docs describe at a higher level.

### Configuration file location

Official Claude Code docs point to `~/.claude/settings.json` and project `.claude/settings.json`. OpenClaude uses `~/.openclaude/settings.json` and `.openclaude/settings.json`. The hook schema itself is identical; only the config directory name differs. The existing plan already targets the official `.claude/settings.json` path, so no change is needed.

### Hook config schema

`src/schemas/hooks.ts` defines:

```ts
export const HooksSchema = z.partialRecord(
  z.enum(HOOK_EVENTS),
  z.array(HookMatcherSchema()),
)

export const HookMatcherSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookCommandSchema()),
})
```

A command hook is:

```ts
z.object({
  type: z.literal('command'),
  command: z.string(),
  if: z.string().optional(),
  shell: z.enum(SHELL_TYPES).optional(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(),
})
```

This matches the config shape already proposed in ../plans/backend-add-pretooluse-read-hook.md.

### Matcher semantics

`src/utils/hooks.ts` `matchesPattern` handles three matcher forms:

1. Empty or `'*'` -> matches everything.
2. Simple string of `a-zA-Z0-9_|` -> exact match, or pipe-separated exact matches.
3. Anything else -> treated as a `RegExp`.

Therefore `"Read"` is an exact match on the tool name. The plan's proposed `"matcher": "Read"` is correct.

### Input JSON shapes

`src/entrypoints/sdk/coreTypes.generated.ts` defines the inputs sent to command hooks on stdin:

**PreToolUse:**

```ts
export type PreToolUseHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PreToolUse"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}
```

**UserPromptSubmit:**

```ts
export type UserPromptSubmitHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "UserPromptSubmit"
  prompt: string
}
```

Both are snake_case, so `vp hook` must inspect `hook_event_name`, `tool_name`, `tool_input`, and `prompt` for Claude Code.

### Output JSON shape

`src/types/hooks.ts` `syncHookResponseSchema` (and the corresponding generated SDK types) define:

```ts
{
  continue?: boolean,
  suppressOutput?: boolean,
  stopReason?: string,
  decision?: "approve" | "block",
  reason?: string,
  systemMessage?: string,
  hookSpecificOutput?:
    | { hookEventName: "PreToolUse", permissionDecision?: ..., permissionDecisionReason?: ..., updatedInput?: ..., additionalContext?: string }
    | { hookEventName: "UserPromptSubmit", additionalContext?: string }
    | ...
}
```

For a context-only vision-proxy hook, the safe minimal outputs are:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "..."
  }
}
```

and

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

### Read tool input

`src/tools/FileReadTool/constants.ts` exports `FILE_READ_TOOL_NAME = 'Read'`.
`src/tools/FileReadTool/FileReadTool.ts` defines the input schema with `file_path: z.string()` (plus optional `offset`, `limit`, `pages`).

A Read tool invocation will therefore present `tool_input.file_path` to the hook, exactly as assumed for Codex. `vp hook` should check this field and fall back to `path` only if needed.

### How additionalContext is injected

`src/utils/messages.ts` pushes hook `additionalContext` as a meta user message:

```ts
messages.push(
  createUserMessage({
    content: response.hookSpecificOutput.additionalContext,
    isMeta: true,
  })
)
```

The prompt in `src/constants/prompts.ts` also tells the model: "Treat feedback from hooks, including <user-prompt-submit-hook>, as coming from the user." This confirms `additionalContext` reaches the model conversation, analogous to Codex's developer-role injection.

## Open questions

- Does the current official Claude Code CLI still use `tool_input.file_path` for the Read tool, or has it changed to `path` or another key? OpenClaude and the existing vision-proxy shim both assume `file_path`, but a live test is required.
- Are there permission / trust checks that prevent third-party hook commands from running until the user explicitly accepts workspace trust? OpenClaude's `executeHooks` skips hooks when workspace trust is not accepted; the official CLI likely behaves similarly.
- Does Claude Code's hook timeout or PATH handling differ from Codex in practice? The plan already uses an absolute `vp` path, which mitigates PATH issues.
- No live prototype has been run on official Claude Code, so end-to-end confidence remains medium.

## Sources

- local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/schemas/hooks.ts
- local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/types/hooks.ts
- local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/entrypoints/sdk/coreTypes.generated.ts
- local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/utils/hooks.ts
- local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/utils/messages.ts
- local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/tools/FileReadTool/constants.ts
- local:/home/tys203831/.opensrc/repos/github.com/Gitlawb/openclaude/main/src/tools/FileReadTool/FileReadTool.ts
- https://code.claude.com/docs/en/hooks
- https://claude.com/blog/how-to-configure-hooks
