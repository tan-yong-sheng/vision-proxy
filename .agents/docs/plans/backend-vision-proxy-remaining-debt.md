---
type: plan
title: Vision Proxy remaining debt
description: Pay down the two accepted pieces of migration debt - shared shim module and Google/Gemini provider support.
area: backend
tags: [vision-proxy, cli, refactoring, provider, gemini]
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-10-13"
related:
  - ../worktrees/backend-vision-proxy-shared-shim.md
  - ../worktrees/backend-vision-proxy-gemini-provider.md
  - ../archive/backend-vision-proxy-cli-migration-review.md
---
# Vision Proxy remaining debt

## Goal capsule

Finish the migration cleanly by addressing the two items left as accepted debt in the QA dossier:

1. Extract duplicated shim code into a shared module.
2. Add Google/Gemini as a supported vision provider.

Both items are independent enough to run in parallel, with a final merge-preview review if they conflict on `package-lock.json`.

## Current state

- The CLI is merged into `configurable-analyze-image-limit` and pushed.
- `fallow audit` exits cleanly but warns about 3 duplication groups:
  - 2 large clone groups between `src/shims/claude-code-user-prompt-submit.mjs` and `src/shims/codex-user-prompt-submit.mjs`.
  - 1 small clone group between `src/commands/config.ts` and `src/commands/provider.ts`.
- Only OpenAI and Anthropic are registered in `src/provider.ts`.

## Target state

- `src/shims/shared.mjs` owns common helpers: `extractImagePaths`, `failOpen`, `readEvent`, `runVP`, `emit`.
- Both shims import from `shared.mjs`; duplication groups drop to zero.
- `src/provider.ts` registers a `google` provider backed by `@ai-sdk/google` using `GOOGLE_API_KEY`.
- `vp provider list` shows `google` alongside OpenAI and Anthropic.
- All tests and typechecks still pass; fallow audit remains exit-zero.

## Key technical decisions

- Use `FilePart` with concrete `image/*` media types for Gemini, same as OpenAI/Anthropic.
- Keep the shared shim module as plain `.mjs` so hook shims stay dependency-free at runtime.
- Update `scripts/copy-shims.mjs` to copy the new `shared.mjs` into `dist/shims/`.
- Add `@ai-sdk/google` as a runtime dependency.

## Deliverables

| Deliverable | Worktree | File(s) |
|---|---|---|
| Shared shim refactor | `vp-shared-shim` | `src/shims/shared.mjs`, `src/shims/claude-code-user-prompt-submit.mjs`, `src/shims/codex-user-prompt-submit.mjs`, `scripts/copy-shims.mjs` |
| Gemini provider | `vp-gemini-provider` | `src/provider.ts`, `package.json`, `package-lock.json`, `src/commands/provider.test.ts` |

## Build steps

1. Create two feature worktrees from `configurable-analyze-image-limit` with `--no-hooks`.
2. Dispatch Claude agents in parallel via `worktrunk-orca-delegation`.
3. Each worker runs tests and typechecks locally.
4. Create a disposable merge-preview worktree and merge both branches in order.
5. Run `npm test`, `npm run typecheck`, and `fallow audit` on the merge preview.
6. Dispatch `/review-gate` if any shared files conflicted.
7. Merge the preview into `configurable-analyze-image-limit`.

## Risks

- `package-lock.json` merge conflict if both worktrees add dependencies. Mitigate by serializing the merge-preview merge order.
- The shared shim module may change the e2e test contract if signatures drift. Mitigate by running shim e2e tests after refactor.
- `@ai-sdk/google` API may differ from OpenAI/Anthropic. Mitigate by reading the current Vercel AI SDK docs before implementation.
