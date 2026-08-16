---
type: coverage
title: OSV-Scanner CI integration QA
description: QA dossier for the OSV-Scanner PR and scheduled workflow integration.
area: backend
tags: [security, ci, osv-scanner, qa]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-11-14"
related: [../plans/backend-osv-scanner-ci-integration.md, ../research/backend-osv-scanner-adoption-for-vision-proxy-ci.md]
---
# OSV-Scanner CI integration QA

## Surface covered

OSV-Scanner CI workflows and ignore policy for dependency vulnerability scanning.

## Deliverables verified

| Deliverable | Path | Status |
|---|---|---|
| PR workflow | `.github/workflows/osv-scanner-pr.yml` | Created |
| Scheduled workflow | `.github/workflows/osv-scanner-scheduled.yml` | Created |
| Ignore policy | `osv-scanner.toml` | Created |
| README security note | `README.md` | Updated |
| AGENTS.md security note | `AGENTS.md` | Updated |

## Local verification results

### Workflow YAML validation

Both workflows parse as valid YAML.

### Baseline scan (without ignore policy)

```
/tmp/osv-scanner scan source -r /tmp/osv-test --format=sarif --output-file=osv-scheduled-noignore.sarif
```

Result: **EXIT 1**, 2 SARIF results:
- CVE-2025-71329: `image-size@2.0.2` — ICNS parser DoS
- CVE-2025-71330 (alias GHSA-w3rx-r6r6-pgpr): same package, same root cause

### Scan with ignore policy

```
/tmp/osv-scanner scan source -r /tmp/osv-test3 --config=osv-scanner.toml --format=sarif --output-file=osv-scheduled-ok.sarif
```

Result: **EXIT 0**, 0 SARIF results. Both vulnerabilities filtered by reason:
> "image-size is used for local file path resolution only; never parses untrusted image data from external sources"

### SARIF upload readiness

The scheduled workflow produces a valid SARIF file that can be uploaded to the GitHub Security tab via `github/codeql-action/upload-sarif@v4`.

## PR workflow behavior

On a real PR to `main`:
1. Checkout `origin/main` and scan base branch → `old-results.json`
2. Checkout PR branch and scan → `new-results.json`
3. Run `osv-reporter-action` to diff results, annotate PR with new vulns, produce `results.sarif`
4. Upload SARIF to GitHub Code Scanning

The PR workflow will **fail** if the PR introduces a new dependency vulnerability not present on `main`.

## Scheduled workflow behavior

Runs every Monday at 12:00 UTC (or manually via `workflow_dispatch`):
1. Full scan of the default branch against `pnpm-lock.yaml`
2. Generates SARIF with all known vulnerabilities
3. Uploads SARIF to GitHub Security tab
4. Reports results but does not fail (uses `--fail-on-vuln=false`)

## Known findings

### image-size@2.0.2 vulnerabilities are accepted risks

Two high-severity DoS vulnerabilities (CVE-2025-71329, CVE-2025-71330) exist in `image-size@2.0.2`. They are ignored in `osv-scanner.toml` because `image-size` is only used for local file path resolution, not for parsing untrusted external image data. The ignore entries have a reason field but no `effectiveUntil` date — they should be revisited when `image-size` is upgraded or replaced.

### Sandbox limitation on local testing

The nono sandbox blocks reads of `/home/tys203831/.gitignore`, which prevents `osv-scanner` from following gitignore rules during local testing. The CI environment does not have this restriction, so the workflows will function correctly in GitHub Actions.

## Retirement criteria

Retire this dossier once the workflows have run successfully in GitHub Actions and the Security tab shows expected results for at least one scheduled scan cycle.
