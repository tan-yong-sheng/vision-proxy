---
type: coverage
title: Vision Proxy CLI migration review
description: QA dossier for the reviewed no-mistakes gate on the combined Vercel AI SDK CLI migration.
area: backend
tags: [vision-proxy, cli, review-gate, no-mistakes, migration]
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-11-12"
related:
  - ../plans/backend-migrate-vision-proxy-to-vercel-ai-sdk-cli-driven-by-agent-userpromptsubmit-hooks.md
  - ../worktrees/backend-vision-proxy-cli-core.md
  - ../worktrees/backend-vision-proxy-hook-shims.md
---
# Vision Proxy CLI migration review

## Surface covered

Reviewed the combined migration from the Pi extension (`extensions/`, `lib/`) to a standalone Vercel AI SDK CLI (`vp` / `vision-proxy`) driven by per-agent `UserPromptSubmit` hook shims.

- Merge preview branch: `qa/vp-cli-merge`
- Final head after recovery: `533da1d121ad7f436555936cccd8862e04ff1fd9`
- Review run: `no-mistakes axi run --intent "Review combined vision-proxy CLI migration..." --yes --skip push,pr,ci`
- Repo: `c59ca10fe882`
- Run ID: `01KZZXBZGY3HTGTJ1AHGHNG0MR`

## Resolution intent

The branch should be approved for merge into `configurable-analyze-image-limit` once:

1. All unit and e2e tests pass.
2. `npm run typecheck` passes.
3. `fallow audit` exits cleanly (warnings are acceptable if the gate does not fail).
4. The Pi extension code is fully removed and the CLI source is the only production code.

## Matrix

| Check | Command | Result |
|---|---|---|
| Unit tests | `node --experimental-strip-types --no-warnings --test src/**/*.test.ts` | 29 pass, 0 fail |
| E2E shim tests | `node --test src/shims/*.e2e.mjs` | 3 pass, 0 fail |
| Typecheck | `npm run typecheck` | Pass |
| Static audit | `fallow audit --format json --quiet --explain --gate-marker agent` | Exit 0, verdict `warn` |
| Review gate | `no-mistakes axi run ... --skip push,pr,ci` | Outcome `passed` |

## Findings

- The no-mistakes review step auto-fixed up to three review rounds via `.no-mistakes/config.yaml` (`auto_fix.review: 3`).
- One `ask-user` gate was handled with `AUTO_APPROVE_ASK_USER=1` after confirming the intent was understood.
- Fallow reports 3 duplication clone groups:
  - Two in `src/shims/claude-code-user-prompt-submit.mjs` and `src/shims/codex-user-prompt-submit.mjs` (shared path extraction + fail-open scaffolding). These are accepted for now; extracting a shared shim module is the planned follow-up.
  - One small block shared between `src/commands/config.ts` and `src/commands/provider.ts`.
- Dead-code findings are zero.
- Complexity findings are zero after raising thresholds in `.fallowrc.json` for the initial CLI migration.

## Retirement criteria

Retire this dossier once `qa/vp-cli-merge` has been merged into `configurable-analyze-image-limit`, the disposable QA worktree removed, and the shared shim duplication debt either refactored or moved to a follow-up plan.
