---
type: coverage
title: codex status and uninstall consistency fix
description: "Verification dossier for the codex integration status/uninstall consistency fix."
area: backend
tags: [codex, integration, cli, regression-test]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-11-14"
related:
  - ../archive/bug-backend-codex-integration-status-and-uninstall-disagree-when-config-marker-is-outside-a-.md
---
# codex status and uninstall consistency fix

## Surface covered

`vp integration status` and `vp integration uninstall codex` consistency when the shim file is missing or the config contains stale markers.

## Resolution intent

Make `codex.isInstalled(raw)` consistent with `codex.remove(raw)` by only reporting installed when `"vision-proxy"` appears inside a `[[UserPromptSubmit]]` block. This prevents the case where status reports installed but uninstall reports "was not installed".

## Matrix

| Check | Command | Result |
|---|---|---|
| Type check | `pnpm run typecheck` | PASS |
| Tests | `pnpm test` | PASS (143 unit + 3 e2e) |
| Regression: stale marker outside block | new unit test | PASS |
| Regression: valid block with missing shim | new unit test | PASS |
| Secrets scan | `pnpm secrets` | PASS |
| Lint / format | `pnpm lint` | PASS |
| Fallow audit | `fallow audit --format json --quiet` | PASS |
| no-mistakes review | `no-mistakes axi run ...` | PENDING |

## Retirement criteria

Retire when the fix branch is merged to `main`.
