---
type: coverage
title: "Manual review: ACP provider support"
description: "Manual review of backend-support-acp-provider branch after no-mistakes agent parser failures."
area: backend
tags: [review, acp, provider, security]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-11-14"
related:
  - ../../worktrees/backend-support-acp-provider.md
---
# Manual review: ACP provider support

## Surface covered

- `src/provider.ts` - ACP provider spec, `resolveAcpModel`, discriminated union
- `src/core.ts` - ACP config keys and sanitization
- `src/commands/config.ts` - ACP config validation
- `src/commands/analyze.ts` - ACP runtime wiring
- `src/commands/provider.ts` - provider list/check handling for ACP
- `package.json` / `pnpm-lock.yaml` - new dependency `@mcpc-tech/acp-ai-provider`
- `README.md` - ACP documentation
- `src/provider.test.ts` / `src/commands/config.test.ts` - ACP tests

## Resolution intent

Automated `no-mistakes` review failed twice with agent output parser errors (the pipeline agent emitted prose instead of JSON). I recovered the branch, accepted the pipeline's auto-fix commit `8d0ebaeb`, then manually reviewed and fixed one additional issue: the ACP `mcpServers` default was an object `{}` cast as `any[]`, which contradicts the ACP SDK's `Array<McpServer>` type. Corrected to an empty array `[]` in commit `f2463b5`.

## Matrix

| Check | Command | Result |
|---|---|---|
| Build | `pnpm run build` | pass |
| Tests | `pnpm test` | 152 + 3 pass |
| Typecheck | `pnpm run typecheck` | pass |
| Fallow audit | `fallow audit --format json --quiet --explain --gate-marker agent` | pass |

## Findings

| ID | Severity | File | Description | Status |
|---|---|---|---|---|
| 1 | medium | `src/provider.ts` | ACP `mcpServers` defaulted to `{}` instead of `[]` | fixed in `f2463b5` |

## Retirement criteria

- Branch is rebased onto `main` after PR #6 lands.
- Final `/review-gate` or no-mistakes run succeeds without parser errors after rebase.
- PR is opened and merged.
