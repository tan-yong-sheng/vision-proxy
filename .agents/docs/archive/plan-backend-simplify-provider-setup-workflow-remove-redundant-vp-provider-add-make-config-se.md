---
type: plan
title: "Simplify provider setup: remove redundant vp provider add, make config set provider the single registration point"
description: "Currently vp config set provider sets the default provider string, but vp provider add is a separate command needed to map the name to an env var. The provider id itself already implies the env var."
area: backend
tags: [setup, provider, CLI-simplification]
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-10-14"
related:
  - ../archive/plan-backend-vision-proxy-post-migration-feature-set.md
  - ./backend-simplify-cli-surface-drop-vp-provider-add-and-unify-vp-hook-into-vp-integration.md
superseded_by: ./backend-simplify-cli-surface-drop-vp-provider-add-and-unify-vp-hook-into-vp-integration.md
---
# Simplify provider setup workflow: remove redundant vp provider add

## Goal capsule

`vp provider add <name>` is redundant — `vp config set provider <name>` already tells the system which provider to use, and the provider id itself implies the env var (`OPENAI_API_KEY`). The `add` command only exists to write the env-var name mapping, which is already implicit.

## Current state

| Command | What it does |
|---------|-------------|
| `vp config set provider openai` | Sets the default provider string |
| `vp provider add openai` | Writes the env-var name mapping (redundant) |

Both commands write to `.vision-proxy.json`, but `provider add` only writes `apiKeyEnv: "OPENAI_API_KEY"` — which is already correct from the provider id.

## Target state

Remove `vp provider add`. The `vp config set provider ...` is the single registration point. The `provider list` command already infers the key presence from the provider id.

```diff
- vp provider add <name>    // removed — config set provider is enough
+ vp config set provider <name>  // single point
```

## Key technical decisions

- `provider list` already uses the provider id to derive `apiKeyEnv` — no separate registration needed.
- The `defaultModelId` is also implicit from the provider id.

## Deliverables

1. Remove `vp provider add` subcommand from `src/cli.ts`.
2. Update `src/commands/provider.ts` — delete `providerAdd`.
3. Update `docs/SETUP.md` — remove references to `provider add`.
4. Update `README.md` — drop the `add` from the commands table.

## Worktree Strategy

Single worktree. Touches `src/cli.ts`, `src/commands/provider.ts`, and docs.

## Risks

Low — `vp provider add` is currently shown in the help but unused by most users (they set env vars directly).
