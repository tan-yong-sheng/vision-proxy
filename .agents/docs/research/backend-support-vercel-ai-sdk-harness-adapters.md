---
type: research
title: support vercel ai sdk harness adapters
description: Evaluate replacing the ACP provider with Vercel AI SDK HarnessAgent.
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

Should we remove the current ACP provider and replace it with Vercel AI SDK `HarnessAgent`?

## Findings

### What Vercel HarnessAgent is

Vercel AI SDK 7.x introduces `HarnessAgent`, a first-party API for running agent harnesses such as Claude Code, Codex, and Pi.
It is currently **experimental** and available via the canary release.

A minimal setup requires three packages:

- `@ai-sdk/harness` (core)
- `@ai-sdk/harness-<runtime>` (adapter, e.g. `harness-claude-code`)
- `@ai-sdk/sandbox-<provider>` (sandbox, e.g. `sandbox-vercel`)

Example from the docs:

```typescript
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { claudeCode } from '@ai-sdk/harness-claude-code';
import { createVercelSandbox } from '@ai-sdk/sandbox-vercel';

const agent = new HarnessAgent({
  harness: claudeCode,
  sandbox: createVercelSandbox({ runtime: 'node24', ports: [4000] }),
  instructions: '...',
});

const session = await agent.createSession();
const result = await agent.generate({ session, prompt: '...' });
await session.destroy();
```

### Key differences from the current ACP provider

| Aspect | Current ACP (`@mcpc-tech/acp-ai-provider`) | Vercel `HarnessAgent` |
|--------|--------------------------------------------|----------------------|
| Maturity | Community package | Official Vercel, but experimental/canary |
| Architecture | Provides a `LanguageModel` via ACP | Provides a stateful `HarnessAgent` with sessions |
| Model selection | Agent/harness chooses the model | Harness chooses the model; caller cannot set `modelId` |
| Runtime requirements | Local agent binary (`acpCommand`) | Sandbox provider + harness adapter + credentials |
| API for `vp` | Drop-in `generateText` replacement | Needs new `agent.generate()` / `agent.stream()` path |
| Dependencies | One package (`ai@6.x` internally) | Core + per-runtime adapter + sandbox provider |

### Can `HarnessAgent` switch models?

No. `HarnessAgent` exposes `generate()` and `stream()` that take a prompt/session; the underlying harness (Claude Code, Codex, etc.) decides which model to use. There is no `modelId` parameter in the `HarnessAgent` API. So it would **not** solve the "cannot set the model to use" problem; it would make model selection impossible from `vp`'s side.

### Can it replace the current ACP provider in `vp analyze`?

Not directly. The current flow is:

1. `vp analyze` resolves a provider to a Vercel `LanguageModel`.
2. `generateText({ model, prompt })` produces a description.

`HarnessAgent` returns an agent object, not a `LanguageModel`. To use it we would need:

- A new `analyze` path that calls `agent.createSession()`, `agent.generate({ session, prompt })`, and `session.destroy()`.
- Sandbox configuration (`sandbox` provider, runtime, ports, credentials).
- Handling of harness-specific features (tools, skills, tool approval) that `vp` does not currently use.

This is a significant code change, not a swap of one provider for another.

### Version issue with current ACP

The current community ACP provider depends on `ai@6.x` internally while the project uses `ai@7.x`.
This triggers a cross-major compatibility warning in no-mistakes.
Replacing it with `HarnessAgent` would remove that warning but introduces:

- Experimental/canary dependencies.
- A sandbox provider dependency and credentials requirement.
- More complex setup for users.

## Recommendation

**Do not replace the current ACP provider with `HarnessAgent`.**

Reasons:

1. `HarnessAgent` is not a drop-in replacement; it changes the architecture from model-call to agent-session.
2. It does **not** expose model selection, so it does not solve the original concern.
3. It is experimental and requires sandbox credentials, making setup harder for users.
4. `vp` is a single-shot image-description CLI; harness sessions are overkill for this use case.

### Better options for the version-mismatch concern

1. **Keep ACP but find/update to an `ai@7`-compatible ACP provider package.**
2. **Remove ACP from PR #7** if the version mismatch is unacceptable, and add it back later when a compatible package exists.
3. **Keep ACP with the version-mismatch warning** and document the limitation clearly.

## Open questions

- Is the `ai@6.x` vs `ai@7.x` mismatch a hard blocker for PR #7, or can it be documented as a known limitation?
- Should we search for an `ai@7`-compatible ACP provider alternative before deciding?
- If ACP is removed from PR #7, should the `docs/providers/acp.md` guide be moved to a draft/PR branch until it is re-added?
