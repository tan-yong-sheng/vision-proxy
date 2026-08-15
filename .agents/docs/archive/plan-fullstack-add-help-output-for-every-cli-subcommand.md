---
type: plan
title: Add --help output for every CLI subcommand
description: "Currently vp help and vp --help print the full help text, but subcommands like vp provider, vp cache, and vp config do not respond to --help. They fail with unknown subcommand."
area: fullstack
tags: [CLI, help, UX]
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ../archive/plan-backend-vision-proxy-post-migration-feature-set.md
  - ./backend-simplify-cli-surface-drop-vp-provider-add-and-unify-vp-hook-into-vp-integration.md
---
# Add --help output for every CLI subcommand

## Goal capsule

Every `vp <subcommand>` should accept `--help` and print its subcommand-specific help, instead of falling through to `unknown subcommand`.

## Current state

Currently:

```bash
vp provider --help   # → "unknown provider subcommand --help. Try: list, add, check"
vp cache --help      # → "unknown cache subcommand --help. Try: status, clear, prune"
vp config --help    # → "unknown config subcommand --help. Try: init, get, set, validate"
```

The `--help` flag is parsed as a `subcommand` name (because `parseFlags` treats `--` as flags, but the `--help` is not stripped before the subcommand switch — it lands in `rest` as a positional, then becomes the `sub` argument).

## Root cause

In `src/cli.ts`, `parseFlags(rest)` splits flags from positionals, but `--help` is consumed as a flag-like value with no value, so it's treated as a boolean flag but never checked. The subcommand switch only sees `positionals[0]` which is empty.

## Target state

```diff
// Each subcommand's switch should check for --help
case "provider":
  case "--help":
  case "-h":
    print(HELP_SECTIONS.provider);
    return;
```

Or more simply: pass `--help` / `-h` through to the `HELP` constant, and add a `--help` handler at the top of each subcommand branch.

## Deliverables

1. Add `--help` / `-h` check before each subcommand case in `src/cli.ts`.
2. Print provider-, cache-, and config-specific help blocks.
3. Update `docs/SETUP.md` to remove the "try" messages from troubleshooting.

## Worktree Strategy

Single worktree. Touches `src/cli.ts` and `docs/SETUP.md`. Coordinate with `vp-cli-simplify` (also touches `src/cli.ts`) — merge `vp-cli-simplify` last so this branch's smaller diff applies cleanly on top.

### Track 1: vp-help-output
- **Area**: fullstack
- **Branch**: `vp-help-output`
- **Objective**: Add a `--help` / `-h` guard before each subcommand switch in `src/cli.ts` so `vp provider --help`, `vp cache --help`, and `vp config --help` print subcommand-specific help instead of `unknown subcommand`.
- **Scope & Files**: `src/cli.ts` (add `--help` check before each `case` block), `docs/SETUP.md` (drop the misleading "Try: ..." messages).
- **Tasks**:
  - [ ] Add `--help` / `-h` check before the `provider`, `config`, and `cache` switches in `src/cli.ts`
  - [ ] Print subcommand-specific help text for each
  - [ ] Update `docs/SETUP.md` troubleshooting to remove the `Try: ...` messages
  - [ ] Add a smoke test exercising `vp provider --help`, `vp cache --help`, `vp config --help`
- **Verification**: `npm test && npm run typecheck && fallow audit`
- **Depends On**: none

## Risks

Low — adding a `--help` guard before the subcommand switch is a 2-line change per top-level command.
