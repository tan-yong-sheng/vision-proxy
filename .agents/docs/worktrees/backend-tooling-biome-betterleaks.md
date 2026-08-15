---
type: worktree
title: tooling biome betterleaks
description: "Worktree to add Biome lint/format and BetterLeaks secret-scanning pre-commit hooks."
area: backend
tags: [tooling, lint, format, secrets, pre-commit, biome, betterleaks]
status: active
branch: vp-tooling-biome-betterleaks
base: main
stack_position: 1
stack_batch: vp-tooling
created: "2026-08-15"
updated: "2026-08-15"
commits_verified: []
merge_preview_verified: ""
stale_after: "2026-08-29"
related:
  - ../plans/backend-tooling-biome-betterleaks.md
  - ../qa/backend-post-merge-qa-for-pr-5.md
---
# tooling biome betterleaks

## Objective

Add Biome as the linter/formatter and BetterLeaks as a pre-commit secret scanner. This tooling should land before the bug-fix and distribution worktrees so later branches inherit the lint/format rules and secret-scanning gate.

## Scope

- `biome.json` - Biome configuration for TS/JS/JSON.
- `.betterleaks.toml` - BetterLeaks scanner configuration and allowlists.
- `lefthook.yml` - pre-commit hooks running Biome and BetterLeaks on staged files.
- `package.json` - add `@biomejs/biome`, `lefthook` dev deps and `lint` / `format` / `lint:fix` scripts.
- `.github/workflows/ci.yml` - CI running Biome, tests, typecheck, and BetterLeaks history scan.
- `README.md` - setup instructions for hooks.
- Auto-format/lint the existing source tree in this PR.

## Tools / MCP / Skills

- Biome CLI (`@biomejs/biome`).
- BetterLeaks CLI.
- Lefthook hook manager.
- GitHub Actions.
- `fallow audit` for change review.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| Biome passes | `npm run lint` | no errors |
| BetterLeaks pre-commit | stage a file and run `git commit` | no secret findings |
| BetterLeaks history | `betterleaks git .` | clean or allowlisted |
| Tests + typecheck | `npm test && npm run typecheck` | green |
| CI | open PR | all checks pass |

## Status

- [ ] Add Biome and Lefthook dependencies.
- [ ] Create `biome.json`.
- [ ] Create `.betterleaks.toml`.
- [ ] Create `lefthook.yml`.
- [ ] Add package scripts.
- [ ] Run Biome fixes across repo.
- [ ] Add CI workflow.
- [ ] Update README.
- [ ] Run `npm test`, `npm run typecheck`, `fallow audit`.
- [ ] Open PR and merge to `main`.

## Open questions

- Which Biome rules to enable/disable? Start with recommended and tune based on the initial scan.
- What BetterLeaks allowlists are needed for existing test data or binary cache files?
- Should the CI BetterLeaks scan run on every PR or only on push to `main`? Recommended: both.
