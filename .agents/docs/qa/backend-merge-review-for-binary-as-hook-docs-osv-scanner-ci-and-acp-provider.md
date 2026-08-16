---
type: coverage
title: "Merge review for binary-as-hook docs, OSV-Scanner CI, and ACP provider"
description: "QA review for the combined integration of PR-6 docs (binary-as-hook), OSV-Scanner CI workflows, and ACP provider support."
area: backend
tags: [merge-preview, acp, osv-scanner, binary-as-hook, review-gate]
status: active
merge_batch: vp-pr-6-integration
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-11-14"
related:
  - ../worktrees/backend-binary-as-hook.md
  - ../worktrees/backend-osv-scanner-ci-integration.md
  - ../worktrees/backend-support-acp-provider.md
  - ../plans/backend-binary-as-hook-vision-proxy-integration.md
  - ../plans/backend-osv-scanner-ci-integration.md
  - ../plans/backend-support-acp-protocol-via-vercel-ai-sdk-as-llm-provider.md
---
# Merge review for binary-as-hook docs, OSV-Scanner CI, and ACP provider

## Surface covered

Combined state of three PR-6 streams:
- `plan/backend-binary-as-hook` documentation and skill mirrors
- `feat/backend-osv-scanner-ci` GitHub Actions workflows and ignore policy
- `backend-support-acp-provider` ACP provider implementation and tests

## Resolution intent

The three source branches diverged from an older `main` that still held active PR-5 docs, so they could not be merged cleanly. I integrated them on a disposable merge-preview branch (`merge-plan-binary`) by:
- Applying the plan/docs branch state first and reconciling it with the already-archived PR-5 docs on `main`
- Cherry-picking the OSV-Scanner workflows and security docs without reverting distribution/README changes
- Merging the ACP provider code and resolving conflicts in `package.json`, `src/commands/analyze.ts`, `src/commands/config.ts`, and `src/commands/provider.ts`
- Regenerating `pnpm-lock.yaml` and verifying `pnpm run typecheck` and `pnpm test`

## Matrix

| Check | Command | Result |
|---|---|---|
| Type check | `pnpm run typecheck` | PASS |
| Tests | `pnpm test` | PASS (155 unit + 3 e2e) |
| Secrets scan | `pnpm secrets` | PASS |
| Lint / format | `pnpm lint` | PASS |
| Fallow audit | `fallow audit --format json --quiet` | PASS |
| no-mistakes review | `no-mistakes axi run ...` | PASS |
| PR opened | - | [#7](https://github.com/tan-yong-sheng/vision-proxy/pull/7) |

## Findings

### Pre-existing: codex uninstall reports "was not installed" while status reports installed

- **Observation:** `vp integration status` reports `✓ codex installed (version unknown)`, but `vp integration uninstall codex` replies `codex integration was not installed`.
- **Root cause:** `isInstalled()` checks `raw.includes("vision-proxy")` anywhere in `~/.codex/config.toml`, while `remove()` only removes `[[UserPromptSubmit]]` blocks that contain the marker. If the marker appears outside a block (stale path, comment, or malformed block), status and uninstall disagree.
- **Status:** pre-existing, not introduced by this merge. No-mistakes did not flag it; existing tests cover happy-path install/uninstall but not the stale-config edge case.

### Auto-fixed by no-mistakes

- `no-mistakes(review): Use pre-resolved ACP model directly in analyze fallback path`
- ACP provider now bypasses `generateWithFallback` and calls the model directly, avoiding re-resolution of an already-resolved ACP model in the fallback loop.

## Retirement criteria

Retire when PR #7 is merged to `main`.
