---
type: worktree
title: vp-help-output
description: "Add a `--help` / `-h` guard before each subcommand switch in `src/cli.ts` so `vp provider --help`, `vp cache --help`, and `vp config --help` print subcommand-specific help instead of `unknown subcommand`."
area: fullstack
tags: [CLI, help, UX]
status: merged
branch: vp-help-output
base: main
stack_position: 1
created: "2026-08-15"
updated: "2026-08-15"
commits_verified: ["vp-help-output@2d241b4"]
stale_after: "2026-08-29"
related: [../plans/fullstack-add-help-output-for-every-cli-subcommand.md]
---
# vp-help-output

## Branch

`vp-help-output` (off `main`). Coordinates with `vp-cli-simplify` (also touches `src/cli.ts`); merge `vp-cli-simplify` last so this branch's smaller diff applies cleanly on top.

## Objective

Add a `--help` / `-h` guard before each subcommand switch in `src/cli.ts` so `vp provider --help`, `vp cache --help`, and `vp config --help` print subcommand-specific help instead of `unknown subcommand`.

## Scope

`src/cli.ts` (add `--help` check before each `case` block), `docs/SETUP.md` (drop the misleading "Try: ..." messages).

## Tasks

- [x] Add `--help` / `-h` check before the `provider`, `config`, and `cache` switches in `src/cli.ts`
- [x] Print subcommand-specific help text for each
- [x] Update `docs/SETUP.md` troubleshooting to remove the `Try: ...` messages
- [x] Add a smoke test exercising `vp provider --help`, `vp cache --help`, `vp config --help`

## Verification

`npm test && npm run typecheck && fallow audit`

## Status

- [x] Worktree created
- [x] Implementation complete
- [x] Tests pass
- [ ] Merged into integration branch
