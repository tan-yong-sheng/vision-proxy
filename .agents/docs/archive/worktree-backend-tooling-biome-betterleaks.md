---
type: worktree
title: tooling Biome + BetterLeaks
description: "Add Biome, BetterLeaks, Lefthook pre-commit, and CI workflow to the vision-proxy backend; apply auto-fixes."
area: backend
tags: [tooling, lint, secrets, ci, biome, betterleaks, lefthook]
status: landed
branch: vp-tooling-biome-betterleaks
base: main
stack_position: 1
created: "2026-08-16"
updated: "2026-08-16"
commits_verified: [pr-6-preview]
merge_preview_verified: qa/pr-5-qa-and-distribution-merge-preview
stale_after: "2026-08-30"
related: [../qa/backend-post-merge-qa-for-pr-5.md]
---

# tooling Biome + BetterLeaks

## Branch

`vp-tooling-biome-betterleaks` (off `main`).

## Objective

Introduce a first-class tooling layer for the vision-proxy backend: a Biome
config for format + lint, a BetterLeaks config for secret scanning, a Lefthook
pre-commit hook that runs both plus the existing fallow gate, and a CI workflow
that runs the full gate on every push/PR. Then apply Biome auto-fixes.

## Root cause / motivation

The repo had no formatter/linter and no local secret-scanning gate. Native
Node 22 TypeScript meant we could adopt Biome (single fast tool) and BetterLeaks
(a gitleaks-compatible Rust scanner) without adding a JS build step for linting.

## Scope

- `biome.json` - Biome config (tabs, 100-col, recommended preset, project rule tweaks).
- `.betterleaks.toml` - BetterLeaks secret-scan config with project allowlists.
- `lefthook.yml` - pre-commit (betterleaks + biome + fallow) and pre-push (betterleaks).
- `.github/workflows/ci.yml` - install, hooks, biome, typecheck, secrets, test.
- `package.json` - `lint`, `format`, `secrets`, `hooks:install` scripts; `lefthook` devDependency.
- `pnpm-lock.yaml` - lefthook lockfile entries.
- `src/**` - Biome auto-fixes (import ordering, literal keys, template literals, unused imports). Two non-fixable findings suppressed with `biome-ignore` (intentional control-char sanitization regex in `core.ts`; a test mock function type in `integration.test.ts` replaced with a typed signature).

## Tasks

- [x] Add Biome config (`biome.json`).
- [x] Add BetterLeaks config (`.betterleaks.toml`).
- [x] Add Lefthook pre-commit (`lefthook.yml`).
- [x] Add CI workflow (`.github/workflows/ci.yml`).
- [x] Apply Biome auto-fixes to `src/**` and config files.
- [x] Run `npm test`, `npm run typecheck`, and `fallow audit`.
- [x] Commit on `vp-tooling-biome-betterleaks`.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| Lint + format | `biome check` | 0 errors (warnings/infos non-blocking) |
| Type check | `tsc --noEmit` | clean |
| Unit + e2e tests | `npm test` | 141 tests pass, 0 fail |
| Secret scan (tree) | `betterleaks dir .` | no leaks found |
| Fallow audit | `fallow audit --gate-marker agent` | verdict: pass |

## Notes

- `node_modules/` and `dist/` are excluded from BetterLeaks via the existing
  `.gitignore`, which the scanner honors.
- Lefthook's git hooks live in `.git/hooks` (gitignored); CI installs them with
  `pnpm lefthook install`. The lefthook binary postinstall is approved in CI.
- Two Biome findings are intentionally suppressed rather than "fixed": the
  `TELEMETRY_UNSAFE_RE` control-char class in `src/core.ts` and a test-tool mock
  type in `src/commands/integration.test.ts` (replaced with an explicit typed
  signature instead of `Function`).
