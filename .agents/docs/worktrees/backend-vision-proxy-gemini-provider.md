---
type: worktree
title: Vision Proxy Gemini provider
description: Add Google/Gemini vision provider support to the vp CLI.
area: backend
tags: [vision-proxy, cli, provider, gemini, google]
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-08-28"
related:
  - ../plans/backend-vision-proxy-remaining-debt.md
  - ../worktrees/backend-vision-proxy-shared-shim.md
---
# Vision Proxy Gemini provider

## Objective

Register a Google/Gemini provider in `src/provider.ts` so users can run `vp analyze` with `--provider google` and a `GOOGLE_API_KEY`.

## Scope

- Add `@ai-sdk/google` as a runtime dependency.
- Import `createGoogleGenerativeAI` from `@ai-sdk/google` in `src/provider.ts`.
- Register a `googleProvider` entry:
  - id: `google`
  - label: `Google`
  - apiKeyEnv: `GOOGLE_API_KEY`
  - baseUrlEnv: `GOOGLE_BASE_URL` (optional)
  - supportsImage: true
  - make factory using `createGoogleGenerativeAI({ apiKey, baseURL })(modelId)`
- Update `src/commands/provider.test.ts` to expect `google` in the provider list.
- Verify the provider list shows Google and respects `GOOGLE_API_KEY`.

## Verification

- `npm install` succeeds and `package-lock.json` is updated.
- `npm run build` succeeds.
- `npm test` passes.
- `npm run typecheck` passes.
- `node dist/cli.js provider list` shows `google`.
- `node dist/cli.js analyze image.png --provider google` reports missing key when `GOOGLE_API_KEY` is unset.

## Status

- [ ] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Merged into integration branch
