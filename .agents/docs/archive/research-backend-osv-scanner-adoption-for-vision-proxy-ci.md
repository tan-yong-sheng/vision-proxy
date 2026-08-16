---
type: research
title: OSV-Scanner adoption for vision-proxy CI
description: Evaluate OSV-Scanner as a lower-risk replacement for Trivy for dependency vulnerability scanning in vision-proxy.
area: backend
tags: [security, dependencies, ci, osv-scanner]
status: complete
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-09-15"
related: []
---
# OSV-Scanner adoption for vision-proxy CI

## Question

Should `vision-proxy` adopt OSV-Scanner instead of Trivy for dependency security scanning in CI, and what would the trade-offs be?

## Findings

### Repo context

`vision-proxy` is a Node 22 TypeScript CLI published as an npm package.
It uses `pnpm` and has a `pnpm-lock.yaml` lockfile.
CI already runs secret scanning with BetterLeaks.
There is no Dockerfile, no container image, no Kubernetes manifests, and no IaC templates.
The primary remaining security scanning need is detection of known vulnerabilities in npm dependencies.

### Why Trivy is not the right default now

Trivy has suffered at least three separate supply-chain or credential compromises in 2026.

1. A malicious Trivy VS Code extension (`1.8.12` and `1.8.13`) was published to OpenVSX after a GitHub PAT was compromised.
This is tracked as CVE-2026-28353.
Source: GitHub security advisory GHSA-8mr6-gf9x-j8qg and NVD.
2. An earlier March 2026 incident exfiltrated credentials from the Trivy project.
Aqua describes this as the precursor that enabled the later attack because credential rotation was not atomic.
Source: Aqua Security blog update and GitHub discussion #10425.
3. On March 19, 2026, a threat actor used compromised credentials to publish a malicious Trivy `v0.69.4` release, force-push `76` of `77` tags in `aquasecurity/trivy-action`, replace all `setup-trivy` tags, and later push malicious DockerHub images `v0.69.5` and `v0.69.6`.
This is tracked as GHSA-69fq-xp46-6x23 / CVE-2026-33634 and is in CISA's Known Exploited Vulnerabilities catalog.
Sources: GitHub security advisory, NVD, Microsoft threat-intel blog.

For `vision-proxy`, Trivy is also a poor functional fit.
Its main strengths are container, IaC, Kubernetes, and secret scanning, none of which this repo uses.
Adopting Trivy would add a large external binary/GitHub Action with a recent history of weaponized CI credential theft for very little benefit.

### OSV-Scanner fit

OSV-Scanner is an open-source vulnerability scanner maintained by Google.
It reads lockfiles and manifests and matches dependencies against the OSV.dev database.

Key points for this repo:

- It supports `pnpm-lock.yaml` directly, including pnpm v9 lockfiles.
Source: OSV-Scanner supported lockfiles documentation.
- It has no known 2026 supply-chain compromise.
- It is smaller and lower-privilege than Trivy.
It reads lockfiles; it does not need a container runtime or broad CI secrets.
- GitHub provides official reusable workflows:
  - PR scan that only reports newly introduced vulnerabilities.
  - Scheduled/push scan that reports all known vulnerabilities and can block release.
Source: OSV-Scanner GitHub Action documentation.
- Output can be SARIF, which integrates with the GitHub Security tab.

### Alternatives considered

| Tool | Scope | pnpm support | Supply-chain risk | Notes |
| --- | --- | --- | --- | --- |
| Trivy | Containers, IaC, secrets, licenses, dependencies | Yes | High in 2026 | Overkill and recently compromised |
| OSV-Scanner | Dependency CVEs | Yes | Low | Best fit for this repo |
| Grype + Syft | Container/filesystem CVEs via SBOM | Via source/SBOM | Low | Good for images; no container here |
| `pnpm audit` | Dependency CVEs | Yes | Low | Uses npm registry advisory data; noisy |
| Dependabot + dependency-review | Dependency CVEs and PR diffs | Yes | Low | Native GitHub; should be enabled alongside OSV |
| CodeQL | Static analysis | N/A | Low | Useful but does not replace dependency scanning |

`pnpm audit` is worth keeping as a fast local check, but the OSV-Scanner action gives clearer PR diffs and SARIF output.
Dependabot alerts and the dependency-review action are complementary and should be enabled in any case.

### Risks and open questions

- OSV-Scanner covers dependency CVEs only.
It does not scan secrets, IaC, licenses, or containers.
BetterLeaks already handles secrets.
- The official reusable workflow references the action by tag (`@v2.5.0`).
For extra supply-chain safety we can pin to the release SHA in our own workflow file.
- The PR scan needs `permissions: actions: read`, `security-events: write`, and `contents: read`.
- We need an ignore/allow-list policy for accepted risks so the scheduled scan does not stay red forever.

## Recommendation

Adopt OSV-Scanner for dependency vulnerability scanning in `vision-proxy` CI.
Do not adopt Trivy as the primary scanner.
Keep BetterLeaks for secrets, enable GitHub Dependabot alerts, and add the dependency-review action for native PR checks.
Revisit Trivy or Grype only if the project later builds container images.

## Sources

- GitHub: `aquasecurity/trivy` security advisory GHSA-69fq-xp46-6x23 - https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23
- GitHub Discussion: Trivy Security incident 2026-03-19 (#10425) - https://github.com/aquasecurity/trivy/discussions/10425
- Aqua Security blog: Update on Trivy supply-chain attack - https://www.aquasec.com/blog/trivy-supply-chain-attack-what-you-need-to-know/
- Microsoft Security Blog: Detecting, investigating, and defending against the Trivy supply chain compromise - https://www.microsoft.com/en-us/security/blog/2026/03/24/detecting-investigating-defending-against-trivy-supply-chain-compromise/
- NVD: CVE-2026-33634 - https://nvd.nist.gov/vuln/detail/CVE-2026-33634
- GitHub: `aquasecurity/trivy-vscode-extension` security advisory GHSA-8mr6-gf9x-j8qg - https://github.com/aquasecurity/trivy-vscode-extension/security/advisories/GHSA-8mr6-gf9x-j8qg
- NVD: CVE-2026-28353 - https://nvd.nist.gov/vuln/detail/CVE-2026-28353
- OSV-Scanner supported lockfiles and manifests - https://google.github.io/osv-scanner/supported-languages-and-lockfiles/
- OSV-Scanner GitHub Action documentation - https://google.github.io/osv-scanner/github-action/
