---
type: coverage
title: "Merge review for binary-as-hook docs and OSV-Scanner CI"
description: "QA review for the combined integration of binary-as-hook documentation and OSV-Scanner CI workflows."
area: backend
tags: [merge-preview, osv-scanner, binary-as-hook, review-gate]
status: active
merge_batch: vp-pr-6-integration
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-11-14"
related:
  - ../worktrees/backend-binary-as-hook.md
  - ../worktrees/backend-osv-scanner-ci-integration.md
  - ../plans/backend-binary-as-hook-vision-proxy-integration.md
  - ../plans/backend-osv-scanner-ci-integration.md
---
# Merge review for binary-as-hook docs and OSV-Scanner CI

## Surface covered

Combined state of two PR-6 streams:
- `plan/backend-binary-as-hook` documentation and skill mirrors
- `feat/backend-osv-scanner-ci` GitHub Actions workflows and ignore policy

The `backend-support-acp-provider` stream was removed from this merge after proving `@mcpc-tech/acp-ai-provider` drops image `FilePart`s and Vercel AI SDK v7 has no first-party ACP replacement.

## Resolution intent

The source branches diverged from an older `main` that still held active PR-5 docs, so they could not be merged cleanly. I integrated them on a disposable merge-preview branch (`merge-plan-binary`) by:
- Applying the plan/docs branch state first and reconciling it with the already-archived PR-5 docs on `main`
- Cherry-picking the OSV-Scanner workflows and security docs without reverting distribution/README changes
- Regenerating `pnpm-lock.yaml` and verifying `pnpm run typecheck` and `pnpm test`

After integration, the ACP provider was removed because the community provider cannot transmit image parts and no first-party replacement exists.

## Matrix

| Check | Command | Result |
|---|---|---|
| Type check | `pnpm run typecheck` | PASS |
| Tests | `pnpm test` | PASS (149 unit + 3 e2e) |
| Secrets scan | `pnpm secrets` | PASS |
| Lint / format | `pnpm lint` | PASS |
| Fallow audit | `fallow audit --format json --quiet --explain --gate-marker agent` | PASS |
| no-mistakes review | `no-mistakes axi run ...` | Review step passed; test step hit agent output parser failure (see Findings) |
| PR opened | - | [#7](https://github.com/tan-yong-sheng/vision-proxy/pull/7) |

## Findings

### Pre-existing: codex uninstall reports "was not installed" while status reports installed

- **Observation:** `vp integration status` reports `✓ codex installed (version unknown)`, but `vp integration uninstall codex` replies `codex integration was not installed`.
- **Root cause:** `isInstalled()` checks `raw.includes("vision-proxy")` anywhere in `~/.codex/config.toml`, while `remove()` only removes `[[UserPromptSubmit]]` blocks that contain the marker. If the marker appears outside a block (stale path, comment, or malformed block), status and uninstall disagree.
- **Status:** pre-existing, not introduced by this merge. No-mistakes did not flag it; existing tests cover happy-path install/uninstall but not the stale-config edge case.

### ACP provider removed

- Proved via a fake ACP agent that `@mcpc-tech/acp-ai-provider@0.3.5` drops image `FilePart`s before sending them to the agent; only text prompts are transmitted.
- Confirmed Vercel AI SDK v7 has no first-party ACP provider.
- Removed ACP provider code, tests, dependency, and documentation from PR #7.

### no-mistakes test step: agent output parser failure

- **Observation:** The `no-mistakes axi run` review step completed with no findings, but the `test` step failed with `pi output parse: invalid character 'a' after object key:value pair`. The agent-generated JSON summary contained embedded newlines inside a string value.
- **Root cause:** no-mistakes test agent output parser does not handle multi-line JSON string values in the agent response.
- **Mitigation:** Ran the full local verification suite manually; all checks pass.
- **Status:** pipeline tooling issue, not a code defect.

## Retirement criteria

Retire when PR #7 is merged to `main`.
