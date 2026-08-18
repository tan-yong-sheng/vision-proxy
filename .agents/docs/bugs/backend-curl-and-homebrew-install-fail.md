---
type: bug
title: curl and homebrew install fail
description: curl and Homebrew installers for the tan-yong-sheng fork do not successfully install vision-proxy.
area: backend
tags: []
status: open
created: "2026-08-16"
updated: "2026-08-16"
priority: medium
entry_point: true
stale_after: "2026-09-15"
related:
  - https://github.com/tan-yong-sheng/vision-proxy
  - ../plans/backend-fix-curl-and-homebrew-install.md
  - ../archive/research-backend-curl-and-homebrew-install-failure-on-tan-yong-sheng-fork.md
  - ../archive/worktree-backend-vp-distribution.md
---
# curl and homebrew install fail

## Repro

1. Visit https://github.com/tan-yong-sheng/vision-proxy.
2. Run the documented curl installer (e.g., `curl -fsSL ... | bash`) on a fresh machine without `vp` installed.
3. Alternatively, run the documented Homebrew tap install command (e.g., `brew tap ...` then `brew install vision-proxy`).
4. Observe that `vp` / `vision-proxy` is not available on `$PATH` after the command reports success, or the install fails with an error.

## Root cause

See ../archive/research-backend-curl-and-homebrew-install-failure-on-tan-yong-sheng-fork.md for the investigation and ../plans/backend-fix-curl-and-homebrew-install.md for the fix plan.

Confirmed causes:

- The Homebrew formula ships with placeholder `sha256` values and is explicitly documented as not installable yet.
- The curl installer has several failure modes: missing `jq`, missing SHA-256 tool, missing release assets, and `~/.local/bin` not being on PATH.

## Fix

Pending root-cause analysis.

## Verification

- [ ] Reproduced on a clean environment (no prior `vp` installation).
- [ ] Confirmed curl install produces a working `vp` binary on `$PATH`.
- [ ] Confirmed `brew install vision-proxy` from the tap produces a working `vp` binary on `$PATH`.
- [ ] Linked to the fix commit / QA dossier once resolved.
