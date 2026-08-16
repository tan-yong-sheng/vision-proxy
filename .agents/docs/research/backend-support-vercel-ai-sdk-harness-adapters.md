---
type: research
title: support vercel ai sdk harness adapters
description: Evaluate supporting Vercel AI SDK harness adapters as an alternative to the ACP provider.
area: backend
tags: []
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-09-15"
related: []
---
# support vercel ai sdk harness adapters

## Question

Should `vp` support Vercel AI SDK harness adapters (`@ai-sdk/harness-*`) in addition to or instead of the ACP provider?

## Findings

### What harness adapters are

Vercel AI SDK harness adapters connect `HarnessAgent` to a specific agent runtime.
They are the harness equivalent of model providers: each adapter wraps one runtime and normalizes sessions, stream events, tools, usage, lifecycle state, and configuration into the harness contract.

Available adapters (as of the docs snapshot):

- `@ai-sdk/harness-claude-code`
- `@ai-sdk/harness-codex`
- `@ai-sdk/harness-deepagents`
- `@ai-sdk/harness-grok-build`
- `@ai-sdk/harness-opencode`
- `@ai-sdk/harness-pi`

Coming soon:

- `@ai-sdk/harness-amp`
- `@ai-sdk/harness-goose`
- `@ai-sdk/harness-mastra`

### How they differ from ACP

| Aspect | ACP provider (`@mcpc-tech/acp-ai-provider`) | Vercel harness adapters |
|--------|---------------------------------------------|-------------------------|
| Protocol | Agent Client Protocol | Vercel AI SDK harness contract |
| Integration | Returns a Vercel `LanguageModel` via ACP | Returns a `HarnessAgent` with session/stream/tool management |
| Use case | Single-shot model calls through an agent | Stateful agent sessions with tool approval/filtering |
| Dependencies | One external package | One adapter per runtime plus `@ai-sdk/harness` |

### Current ACP provider in `vp`

- `src/provider.ts` defines an `acp` provider.
- `src/adapter.ts` resolves the ACP model via `@mcpc-tech/acp-ai-provider@0.3.5`.
- The CLI treats ACP like any other provider: set `provider=acp`, configure `acpCommand`, run `vp analyze`.

### Pros of adding harness adapters

1. **First-party Vercel integration.** Adapters are published by Vercel and maintained alongside the AI SDK.
2. **More runtime support.** Covers Claude Code, Codex, OpenCode, Pi, and others with one abstraction.
3. **Built-in session/tool management.** Harness agents can expose tools, approval flows, and lifecycle state.
4. **Future proofing.** If the project moves toward agent-session-based analysis, harness adapters fit naturally.

### Cons and risks

1. **Scope creep.** `vp` today is a single-shot image-description CLI; harness adapters are designed for stateful agent sessions.
2. **Additional dependencies.** Each adapter is a separate npm package, increasing install size and CVE surface.
3. **API mismatch.** `generateText` from the AI SDK expects a `LanguageModel`; harness adapters return `HarnessAgent`, so `src/adapter.ts` would need a new code path.
4. **Overlap with ACP.** The ACP provider already lets users route calls through Claude Code / Codex / Gemini CLI. Adding harness adapters may duplicate that value unless we need harness-specific features.
5. **Version alignment.** The current ACP provider already triggers a no-mistakes warning because it depends on `ai@6.x` internally while the project uses `ai@7.x`. Adding more Vercel packages could amplify version-mismatch risk.

### Recommendations

- **Defer harness adapters** unless a concrete feature needs stateful agent sessions (for example, multi-turn tool use, persistent agent context, or built-in tool approval).
- If the goal is simply to route image analysis through Claude Code / Codex / Gemini CLI, the existing ACP provider is sufficient.
- Revisit harness adapters when `vp` evolves from single-shot calls toward agent-session workflows.

## Open questions

- Is there a specific harness feature (tool approval, multi-turn sessions, etc.) that `vp` needs?
- Would harness adapters replace ACP or live alongside it as a separate provider category?
- How would `vp analyze` map to a `HarnessAgent` session: one-shot invocation or persistent session per image?
