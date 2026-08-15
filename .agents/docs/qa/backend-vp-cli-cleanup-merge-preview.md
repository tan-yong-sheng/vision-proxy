---
type: coverage
title: vp-cli-cleanup merge preview
description: "Local merge-preview QA for the four parallel vision-proxy CLI cleanup branches."
area: backend
tags: [cli, integration, provider, config, merge-preview, qa]
status: active
created: "2026-08-15"
updated: "2026-08-16"
stale_after: "2026-11-13"
related:
  - ../worktrees/backend-vp-cli-simplify.md
---
# vp-cli-cleanup merge preview

## Surface covered

Combined state of four parallel cleanup branches merged into a disposable preview worktree:

| Branch | Commit | Scope |
|--------|--------|-------|
| vp-config-keys | 0d210ba | fallbackModels + per-provider baseURL config keys |
| vp-help-output | 905641e | --help output for every subcommand |
| vp-remove-allow-home | 1fc80ff | drop VP_ALLOW_HOME, allow home paths by default |
| vp-cli-simplify | b487137 | unify vp hook into vp integration, add integration status with version markers |

Preview worktree: `qa/vp-cli-cleanup-merge` (local only, deleted after verification).

## Resolution intent

Two merge conflicts were resolved mechanically:

1. **docs/SETUP.md troubleshooting table**
   - Took `vp-remove-allow-home` side: home paths are allowed by default, so the fix is "Use an absolute path inside tmp, cwd, or the home directory".
   - Dropped the `vp provider add` row because `vp-cli-simplify` removes that command.

2. **src/cli.ts command switch**
   - Took `vp-cli-simplify` side: removed the legacy `case "hook"` block.
   - Kept the unified `case "integration"` block.

3. **vp-help-output follow-up**
   - Added `integration list` and `integration status` help blocks and tests on `vp-help-output` so the merged HELP_INDEX covers the new subcommands.

## Matrix

| Check | Command | Result |
|-------|---------|--------|
| Unit + e2e tests | `npm test` | 141 tests pass, 0 fail |
| Type check | `npm run typecheck` | clean |
| Fallow audit | `fallow audit --format json --quiet --explain --gate-marker agent` | verdict: pass, 0 introduced findings |

## Findings

- No new dead code.
- No new complexity/duplication/style findings.
- No circular dependencies.
- Merge conflicts were mechanical and resolved without behavioral changes.

## Retirement criteria

Retire this dossier once all four source branches have landed in `main` and CI matches the local verification results.
