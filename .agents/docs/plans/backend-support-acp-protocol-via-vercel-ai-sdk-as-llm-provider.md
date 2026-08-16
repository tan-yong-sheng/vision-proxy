---
type: plan
title: Support ACP protocol via Vercel AI SDK as LLM provider
description: Add ACP (Agent Client Protocol) as a first-class vision-proxy provider so users can route image analysis through ACP-compatible agent processes using the Vercel AI SDK community provider.
area: backend
tags: ["provider", "acp", "ai-sdk", "agent-client-protocol"]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related: []
---
# Support ACP protocol via Vercel AI SDK as LLM provider

## Goal capsule

Allow `vp analyze` to use an ACP-compatible agent process (Claude Code, Gemini CLI, Codex CLI, etc.) as its vision model backend by integrating the community `@mcpc-tech/acp-ai-provider` package with the existing Vercel AI SDK adapter.

## Current state

- `src/provider.ts` registers three API-key providers: `openai`, `anthropic`, and `google`.
- Each provider conforms to `ProviderSpec`, which assumes an API key, an optional base URL, a model id, and a synchronous factory.
- Configuration keys for `provider`, `model`, `*ApiKey`, and `*BaseURL` are stored in `.vision-proxy.json` via `vp config set`.
- The adapter in `src/adapter.ts` calls `generateText({ model, messages })` without provider-specific branches.

## Target state

- A new provider id `acp` is available in `vp config set provider acp`.
- ACP configuration is persisted in `.vision-proxy.json`:
  - `acpCommand` (string, required) - the agent executable, e.g. `claude-code-acp`, `gemini`, `codex-acp`.
  - `acpArgs` (string[], optional) - CLI args such as `["--experimental-acp"]`.
  - `acpCwd` (string, optional) - working directory for the spawned agent.
  - `acpMcpServers` (object[], optional) - MCP server configs passed to the ACP session.
- When `provider=acp`, `src/provider.ts` constructs a `createACPProvider(...).languageModel()` instance instead of the API-key factories.
- `vp provider list` and help text include ACP with a short label.
- `vp config set` validates ACP fields and rejects unsupported combinations (e.g. `model` is ignored for ACP because the provider exposes a single language model).
- Tests cover ACP model construction, config round-tripping, and missing required fields.

## Key technical decisions

1. **Dependency.** Add `@mcpc-tech/acp-ai-provider` as a normal dependency. It is a community provider, so pin an exact version and keep the package optional only if bundle size or stability becomes a concern.
2. **Provider abstraction seam.** ACP does not fit the existing `ProviderSpec` contract (no API key, no model id, async process spawn). Introduce a discriminated union:
   - `ApiProviderSpec` for the current API-key providers.
   - `AcpProviderSpec` for ACP, with `make()` taking `{ command, args, env, session }`.
3. **Model id handling.** The ACP provider exposes exactly one language model. If `provider=acp`, the configured `model` value is ignored with a warning, and `resolveModel` returns the ACP model regardless of `modelId`.
4. **Security.** ACP spawns a child process from a user-configured command. Validate the command against a configurable allowlist or require an explicit opt-in (`VP_ACP_ALLOW_UNRESTRICTED=1`) before accepting arbitrary binaries. Document this clearly because vision-proxy is often run inside sandboxed agent environments.
5. **Error handling.** Surface ACP process spawn failures and stderr in a user-friendly message, distinct from HTTP API errors.
6. **Backwards compatibility.** Existing openai/anthropic/google flows are unchanged. ACP fields are stored only when the provider is `acp`.

## Deliverables

| # | Deliverable | File(s) | Verification |
|---|---|---|---|
| 1 | Add `@mcpc-tech/acp-ai-provider` dependency | `package.json`, `pnpm-lock.yaml` | `pnpm install` succeeds and lockfile is updated |
| 2 | Extend provider registry with ACP | `src/provider.ts` | Unit tests for `resolveModel("acp")` |
| 3 | Persist ACP config keys | `src/config.ts`, `src/core.ts` | Config round-trip tests |
| 4 | Validate ACP config in CLI | `src/commands/config.ts` | `vp config set acpCommand gemini` accepted; missing `acpCommand` rejected |
| 5 | Adapter remains provider-agnostic | `src/adapter.ts` | No code changes expected; existing tests pass |
| 6 | Update help and provider list | `src/cli.ts`, `src/commands/provider.ts` | `vp provider list` shows `acp` |
| 7 | Documentation | `README.md`, agents-docs plan | Installation and security notes |
| 8 | Tests | `src/provider.test.ts`, `src/config.test.ts`, `src/commands/config.test.ts` | `pnpm test` passes |

## Worktree Strategy

Single worktree: `backend-support-acp-provider`.

- The change is confined to provider construction, config schema, and CLI validation.
- The adapter layer is already provider-agnostic, so no parallel tracks are needed.
- Depends on the merged provider/config refactor in `main` (post PR #6).

## Tools / MCP / Skills

- Vercel AI SDK `ai` package.
- `@mcpc-tech/acp-ai-provider` community provider.
- `worktrunk-orca-delegation` for isolated implementation if the user wants parallel dispatch.

## Risks

1. **Process-spawning security.** ACP executes a user-supplied binary. Mitigate with allowlist validation or explicit opt-in.
2. **Community provider stability.** `@mcpc-tech/acp-ai-provider` is not maintained by Vercel. Pin the version and gate on tests before releases.
3. **No model selection.** Users may expect `vp config set model` to work for ACP. Document that ACP exposes a single model and the setting is ignored.
4. **Sandbox incompatibility.** Some agent sandboxes block subprocess execution. ACP should degrade gracefully with a clear error message suggesting API-key providers instead.

## Open questions

- Should ACP be marked experimental in the first release (e.g. `provider=acp-experimental`)?
- Do we want to support MCP server discovery from a project-level `.acp/mcp.json` file?
