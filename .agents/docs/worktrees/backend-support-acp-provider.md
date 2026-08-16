---
type: worktree
title: support acp provider
description: Add ACP (Agent Client Protocol) as a vision-proxy provider using the Vercel AI SDK community provider.
area: backend
tags: [provider, acp, ai-sdk, agent-client-protocol]
status: active
branch: backend-support-acp-provider
base: main
stack_position: 1
stack_batch: vp-new-providers
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-08-30"
commits_verified: []
merge_preview_verified: ""
related:
  - ../plans/backend-support-acp-protocol-via-vercel-ai-sdk-as-llm-provider.md
---
# support acp provider

## Objective

Add `acp` as a first-class provider in vision-proxy so users can route image analysis through ACP-compatible agent processes (Claude Code, Gemini CLI, Codex CLI, etc.) via the `@mcpc-tech/acp-ai-provider` package.

## Scope

- `src/provider.ts` - extend provider registry with ACP spec.
- `src/config.ts`, `src/core.ts` - persist ACP config keys (`acpCommand`, `acpArgs`, `acpCwd`, `acpMcpServers`).
- `src/commands/config.ts` - validate ACP fields in `vp config set`.
- `src/cli.ts`, `src/commands/provider.ts` - include ACP in provider list and help.
- `package.json`, `pnpm-lock.yaml` - add `@mcpc-tech/acp-ai-provider` dependency.
- Tests for provider construction, config round-trip, and CLI validation.
- README update for ACP setup and security notes.

## Tools / MCP / Skills

- Vercel AI SDK `ai` package.
- `@mcpc-tech/acp-ai-provider` community provider.
- `node --test` for unit tests.
- `fallow audit` for change review.
- `git worktree` / `wt` for isolation.

## Verification

| Check | Command | Result |
|---|---|---|
| Install deps | `pnpm install` | `@mcpc-tech/acp-ai-provider` resolves |
| Build | `pnpm run build` | clean |
| Tests | `pnpm test` | green |
| Type check | `pnpm run typecheck` | clean |
| Lint/format | `pnpm run lint` / `pnpm run format` | clean |
| Fallow audit | `fallow audit --format json --quiet --explain --gate-marker agent` | pass |

## Status

- [ ] Add `@mcpc-tech/acp-ai-provider` dependency.
- [ ] Extend provider registry with ACP spec.
- [ ] Persist ACP config keys.
- [ ] Validate ACP config in CLI.
- [ ] Update help and provider list.
- [ ] Add tests.
- [ ] Update README.
- [ ] Run verification commands.
- [ ] Open PR and merge to `main`.

## Open questions

- Should ACP be marked experimental in the first release?
- Do we want to support MCP server discovery from a project-level `.acp/mcp.json`?
