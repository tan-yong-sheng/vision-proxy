---
type: research
title: Hook-based tool interception for vision-proxy
description: Investigate whether vision-proxy can intercept image-analysis tool calls via agent hooks instead of scanning prompt text.
area: backend
tags: [cli, hooks, claude-code, codex, pi, pretooluse, integration]
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-11-13"
related:
  - ../plans/backend-cli-distribution-strategy.md
  - ../qa/backend-post-merge-qa-for-pr-5.md
---
# Hook-based tool interception for vision-proxy

## Question

Can `vision-proxy` be registered as a tool via agent hooks so that when the agent attempts to call an image-analysis tool, the hook intercepts the call and routes it through `vp analyze` instead?

Specifically:

- Is there a `PreToolUse` or equivalent hook in Claude Code?
- Is there a similar hook in Codex?
- How does Pi's coding agent expose tool hooks?

## Current approach

The current Claude Code / Codex shims use the `UserPromptSubmit` hook. They scan the user prompt text for image paths and append the `vp analyze` output as `additionalContext`. The agent then decides whether to use its own vision tool or the context we injected.

## Claude Code hooks

Claude Code exposes `UserPromptSubmit` hooks documented in the settings schema. There is no documented `PreToolUse` hook in the public Claude Code hook API. Hook events are limited to user-turn lifecycle hooks; tool execution is not externally interceptable via the `settings.json` hook configuration.

- **Feasibility:** Low for tool-level interception. The only reliable hook is `UserPromptSubmit`, which runs before the agent processes the turn.
- **Alternative:** Keep scanning prompt text for image paths and injecting `additionalContext`. The agent may still call its own vision tool if available, but the context is present.

## Codex hooks

Codex uses a TOML `config.toml` with `[[UserPromptSubmit]]` blocks. The documented hook surface is the same user-turn hook. There is no documented `PreToolUse` or tool-interception hook.

- **Feasibility:** Low for tool-level interception. Same constraint as Claude Code.

## Pi coding agent

Pi's extension model lets an extension register tools with a `registerTool` callback. The registered tool can be invoked by Pi and can itself shell out to `vp analyze`. This is closer to true tool interception because Pi can be configured to prefer the extension's tool over its own, but it still requires Pi to route the call.

- **Feasibility:** Higher than Claude Code / Codex because Pi explicitly supports custom tools. However, fully replacing Pi's native image tool depends on Pi's tool-ranking behavior.

## Options

1. **Keep current `UserPromptSubmit` hooks for Claude Code / Codex, Pi extension for Pi.**
   - Pro: works with documented APIs.
   - Con: cannot prevent the agent from also using its own vision tool.

2. **Investigate undocumented / lower-level interception.**
   - Pro: could give true tool replacement.
   - Con: fragile, version-dependent, likely unsupported.

3. **Provide a custom MCP server instead of hooks.**
   - Pro: Claude Code supports MCP tools; user could disable the native image tool and enable the MCP vision tool.
   - Con: Requires users to configure MCP; not a hook-based install.

## Recommendation

For Claude Code and Codex, stick with the current `UserPromptSubmit` hook approach. Tool-level interception is not exposed in their public hook APIs. For Pi, the extension tool model already gives the best integration possible.

If true tool replacement becomes a requirement, consider building an MCP server as a separate distribution channel.

## Open questions

- Does Claude Code's `settings.json` support any hook other than `UserPromptSubmit`?
- Does Codex plan to expose tool hooks in future releases?
- Should vision-proxy provide an MCP server for Claude Code / Codex users who want tool-level control?
