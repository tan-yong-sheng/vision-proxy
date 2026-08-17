---
type: research
title: curl and homebrew install failure on tan-yong-sheng fork
description: Identify why curl and Homebrew installation fail for the tan-yong-sheng/vision-proxy fork and what fix is needed.
area: backend
tags: []
status: complete
superseded_by: ../plans/backend-fix-curl-and-homebrew-install.md
created: "2026-08-16"
updated: "2026-08-16"
sources:
  - https: //github.com/tan-yong-sheng/vision-proxy
  - local: /home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh
  - local: /home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/Formula/vision-proxy.rb
stale_after: "2026-09-15"
related:
  - ../bugs/backend-curl-and-homebrew-install-fail.md
  - https: //github.com/tan-yong-sheng/vision-proxy
---
# curl and homebrew install failure on tan-yong-sheng fork

## Question

Why do the documented curl and Homebrew install paths fail for https://github.com/tan-yong-sheng/vision-proxy, and what fix is required?

## Summary of findings

| # | Finding | Relevance | Confidence | Evidence |
|---|---------|-----------|------------|----------|
| 1 | The Homebrew formula ships with placeholder `sha256` values; `brew install` will fail checksum verification until the real hashes are filled in. | critical | high | local:/home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/Formula/vision-proxy.rb |
| 2 | The README explicitly warns that the Homebrew formula is not installable yet and recommends the curl installer as the working path. | critical | high | https://github.com/tan-yong-sheng/vision-proxy |
| 3 | The curl installer depends on `jq`, a SHA-256 tool, and Node >= 22 on PATH; missing dependencies produce hard errors rather than graceful fallbacks. | normal | high | local:/home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh |
| 4 | The curl installer symlinks `vp` into `~/.local/bin` but does not verify that directory is on the user's PATH, leaving a successful install unusable until the user updates their shell profile. | normal | high | local:/home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh |
| 5 | The curl installer downloads release assets by OS/arch name; if the matching tarball or `sha256sum.txt` is absent from the release, the install fails with "no asset ... for ${VERSION}". | normal | medium | local:/home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh |

## Findings

### Homebrew formula is intentionally non-functional

The formula in `Formula/vision-proxy.rb` uses `sha256 "0000000000000000000000000000000000000000000000000000000000000000"` for all four OS/arch combinations (verified-by: local:/home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/Formula/vision-proxy.rb). Homebrew rejects any formula whose declared checksum does not match the downloaded tarball, so `brew install` cannot succeed today. The README itself acknowledges this and points users to the curl installer until a release's `sha256sum.txt` is used to backfill the hashes.

### curl installer has several failure modes

`scripts/install.sh` is a POSIX shell script that:

1. Resolves the latest (or pinned) GitHub release via the GitHub API.
2. Selects the asset named `vision-proxy-${os}-${arch}.tar.gz`.
3. Downloads the asset and `sha256sum.txt`.
4. Verifies the tarball checksum.
5. Extracts it to `~/.local/share/vision-proxy/${VERSION}`.
6. Symlinks `~/.local/bin/vp` to the extracted binary.
7. Warns if Node < 22 or `~/.local/bin` is not on PATH.

Confirmed failure modes:

- **Missing `jq`**: the script exits with "'jq' is required but not found on PATH".
- **Missing SHA-256 tool**: exits with "'sha256sum' or 'shasum' is required".
- **Missing release asset**: exits with "no asset 'vision-proxy-linux-x64.tar.gz' for vX.Y.Z" if the release was tagged before CI finished uploading assets.
- **PATH not updated**: the install reports success but prints a NOTE that `~/.local/bin` is not on PATH; until the user acts, `vp` is not runnable.
- **Node < 22**: prints a warning but does not block install; the user will hit runtime errors later.

### What needs to be fixed

1. **Homebrew**: fill in the real per-arch `sha256` values from the release's `sha256sum.txt` before tagging a release (this is already documented as the intended workflow).
2. **curl installer**: consider making it more robust by:
   - Adding a dependency check with actionable messages (or bundling a minimal JSON parser to remove the `jq` dependency).
   - Optionally auto-adding `~/.local/bin` to the shell profile, or at least printing the exact shell snippet.
   - Verifying the release has the expected asset before download, with a clearer error if the release is still building.

## Open questions

- Does the fork's CI actually publish the four `vision-proxy-${os}-${arch}.tar.gz` assets plus `sha256sum.txt` on release?
- Is the failure the user observed specifically the Homebrew placeholder sha256, the curl missing-asset error, or a PATH issue?

## Sources

- https://github.com/tan-yong-sheng/vision-proxy (README install section)
- local:/home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh
- local:/home/tys203831/.opensrc/repos/github.com/tan-yong-sheng/vision-proxy/main/Formula/vision-proxy.rb
