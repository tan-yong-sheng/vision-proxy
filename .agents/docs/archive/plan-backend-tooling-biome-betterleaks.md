---
type: plan
title: tooling biome betterleaks
description: Add Biome linter/formatter and BetterLeaks secret-scanning pre-commit hooks to reduce/prevent secrets leakage.
area: backend
tags:
  - tooling
  - lint
  - format
  - secrets
  - pre-commit
  - biome
  - betterleaks
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ../worktrees/backend-tooling-biome-betterleaks.md
  - ../qa/backend-post-merge-qa-for-pr-5.md
---
# tooling biome betterleaks

## Goal capsule

Add Biome as the project's linter and formatter, and add BetterLeaks as a pre-commit (and CI) secret scanner so that secrets are blocked before they enter git history.

## Current state (grounded)

- `package.json` has no lint or format scripts; only `typecheck`, `test`, `build`, and `prepare`.
- No `.github/workflows/` directory exists, so there is no CI lint or secret scan.
- No hook manager (Husky, Lefthook, pre-commit) or secret scanner is configured.
- The repo currently relies on `fallow audit` for code-quality gating, but that is separate from lint/format/secret checks.

## Target state

- `biome.json` configures Biome for TypeScript, JavaScript, and JSON in this Node 22+ project.
- `package.json` adds `lint` and `format` scripts powered by Biome (`lint` runs `biome check`; `format` runs `biome check --write`).
- `.betterleaks.toml` configures BetterLeaks with sensible rules and allowlists for the repo.
- `lefthook.yml` runs `biome check` and `betterleaks git --pre-commit` against staged files before each commit.
- `.github/workflows/ci.yml` runs `biome ci`, `npm test`, and `betterleaks git .` on PRs and pushes to `main`.
- README documents how to install the git hooks (`lefthook install`) and run lint/format locally.

## Key technical decisions

| ID | Decision | Rationale |
|----|----------|----------|
| D1 | Use Biome for both linting and formatting. | One tool replaces ESLint + Prettier; fast, TypeScript-native, and works with Node 22. |
| D2 | Use BetterLeaks (not gitleaks/trufflehog) for secret scanning. | User explicitly requested BetterLeaks; it supports `git --pre-commit` and history scans. |
| D3 | Use Lefthook as the hook manager. | Lightweight, config in one file, runs commands in parallel, no separate `lint-staged` needed. |
| D4 | Apply Biome fixes in the tooling PR itself. | The codebase is small enough to auto-format/lint in one go; avoids every subsequent PR being noisy. |
| D5 | BetterLeaks pre-commit scans staged diffs only; CI scans full history. | Local speed + full-history coverage on the server. |
| D6 | Start Biome with the `recommended` rule set plus import organization. | Sensible default for a Node 22+ TS CLI; tune only after the first real run shows noise. |
| D7 | Start BetterLeaks with the upstream default config plus project-specific allowlists. | Avoids false positives on lockfiles, generated dist, fallow cache, and test fixtures. |

## Deliverables

1. `biome.json` - formatter and linter configuration.
2. `.betterleaks.toml` - secret scanner configuration.
3. `lefthook.yml` - pre-commit hook definitions.
4. `package.json` updates - dev dependencies and scripts.
5. `.github/workflows/ci.yml` - CI quality gate.
6. README updates - setup and contribution instructions.
7. Auto-fixed source files (format/import order/lint-safe fixes only).

## Worktree Strategy

- **Branch:** `vp-tooling-biome-betterleaks` (off `main`).
- **Batch:** `vp-tooling` (phase 1, stack_position 1).
- **Area:** backend.
- **Objective:** Land lint/format rules and secret-scanning hooks so all later branches inherit them.
- **Tasks:**
  - [ ] Add `@biomejs/biome` and `lefthook` dev dependencies.
  - [ ] Create `biome.json`.
  - [ ] Create `.betterleaks.toml`.
  - [ ] Create `lefthook.yml`.
  - [ ] Add lint/format scripts to `package.json`.
  - [ ] Run `biome check --write` across the repo and commit safe fixes.
  - [ ] Create `.github/workflows/ci.yml`.
  - [ ] Update README.
  - [ ] Run `npm test`, `npm run typecheck`, `fallow audit`.
  - [ ] Open PR and merge to `main`.
- **Verification:** `git commit` triggers Biome + BetterLeaks; CI passes; no secret findings on current history.

## Risks / open questions

- BetterLeaks may flag existing test fixtures, sample API keys, or the `.fallow/cache.bin` binary. These need allowlisting in `.betterleaks.toml`.
- If Biome rules are too strict (e.g. certain stylistic preferences), the initial PR becomes noisy. Start with the recommended rules and disable only what is genuinely unhelpful.
- Lefthook requires contributors to run `lefthook install` once; document this clearly in README.
