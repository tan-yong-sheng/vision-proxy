---
type: worktree
title: vp distribution
description: "Implement npm-free distribution for vision-proxy: GitHub Releases tarballs + Homebrew tap + curl installer."
area: backend
tags: [cli, distribution, homebrew, github-releases, curl, install]
status: landed
branch: vp-distribution
base: main
stack_position: 2
stack_batch: vp-distribution
depends_on:
  - ../worktrees/backend-prune-max-tool-calls-per-turn.md
  - ../worktrees/backend-fix-pi-extension-typebox-dependency.md
  - ../worktrees/backend-tooling-biome-betterleaks.md
created: "2026-08-15"
updated: "2026-08-15"
commits_verified: [pr-6-preview]
merge_preview_verified: qa/pr-5-qa-and-distribution-merge-preview
stale_after: "2026-08-29"
related:
  - ../plans/backend-cli-distribution-strategy.md
  - ../worktrees/backend-prune-max-tool-calls-per-turn.md
  - ../worktrees/backend-fix-pi-extension-typebox-dependency.md
  - ../worktrees/backend-tooling-biome-betterleaks.md
  - ../plans/backend-tooling-biome-betterleaks.md
---
# vp distribution

## Objective

Implement the npm-free distribution strategy from `../plans/backend-cli-distribution-strategy.md`: build per-OS/arch tarballs from `dist/`, publish them to GitHub Releases with checksums, add a Homebrew tap formula, and provide a curl installer script. Runs in parallel with the `vp-qa-fixes` batch because it touches release/Homebrew/install files, not `src/commands/integration.ts`.

## Scope

- `.github/workflows/release.yml` - build `dist/` on linux-x64/arm64, darwin-x64/arm64, windows-x64, upload tarballs + `sha256sum.txt`.
- `scripts/install.sh` - curl installer: detect OS/arch, fetch latest release asset, verify checksum, extract, symlink to `~/.local/bin`.
- `tan-yong-sheng/homebrew-tap` formula (`vision-proxy.rb`) - `url` pointing at GitHub release tarball, `depends_on "node@22"`, `bin.install "vp"`.
- `README.md` - install instructions for Homebrew and curl (remove npm-first guidance).

## Tools / MCP / Skills

- GitHub Actions for cross-platform builds + releases.
- Homebrew tap repository under `tan-yong-sheng/homebrew-tap`.
- `curl` + `jq` + `sha256sum` for the installer.
- `fallow audit` for change review.
- `git worktree` / `wt` for isolation.

## Verification

| Check | Command | Result |
|-------|---------|--------|
| Build all platforms | `act` or push a tag and check GitHub Actions | Release created with 5 assets + checksum file |
| Curl install | `./scripts/install.sh` in a clean container/VM | `vp --version` works, on `PATH` |
| Homebrew install | `brew install tan-yong-sheng/tap/vision-proxy` in a clean macOS/Linux env | `vp --version` works |
| Hook shims travel together | install `vp`, then `vp integration install claude-code` | `shared.mjs` present next to the shim (blocked by finding #4) |

## Status

- [ ] Add GitHub Actions release workflow (per-OS/arch tarball + checksums).
- [ ] Add `scripts/install.sh` with OS/arch detection and checksum verification.
- [ ] Add Homebrew formula in `tan-yong-sheng/homebrew-tap`.
- [ ] Update README install section (Homebrew + curl, no npm publish).
- [ ] Cut a test release and validate both install paths.
- [ ] Run `fallow audit`.
- [ ] Open PR and merge to `main`.

## Open questions

- Does this depend on fixing finding #4 first? Functionally the release can ship, but hook installs will break at runtime if `shared.mjs` is missing; best to land #4 before the first public release.
- Should we attempt `bun build --compile` (Track B) in this worktree or defer to a follow-up worktree? Recommended: defer.
