---
type: plan
title: "CLI distribution strategy"
description: "Decide how users install the vision-proxy CLI globally and how the hook shims find the binary."
area: backend
tags: [cli, distribution, packaging, homebrew, github-releases, curl, bun, install]
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-11-13"
related:
  - ../qa/backend-post-merge-qa-for-pr-5.md
---
# CLI distribution strategy

## Objective

Make `vision-proxy` easy to install globally so agent hooks (Claude Code / Codex) and end users can run `vp` without knowing the repo path.

## Motivation

Current pain points observed during QA:

- The built CLI at `dist/cli.js` is not on the user's `PATH` by default.
- Hook shims shell out to `vp` (or `$VP_BIN`). If the binary is not on `PATH`, hooks fail with "vp binary not found".
- Users must `npm install -g .` or `npm link` from the repo, which requires Node/npm familiarity.

## Options under consideration

### A. npm global install (existing)

- **How:** `npm install -g vision-proxy` from the npm registry.
- **Pros:** Standard Node ecosystem path; `package.json` already declares a `bin` entry.
- **Cons:** Requires npm; version updates need `npm update -g vision-proxy`.
- **Needs:** Publish the package to npm (or keep using `npm install -g .` for local installs).

### B. curl-based install script

- **How:** One-liner such as `curl -fsSL https://.../install.sh | sh` that downloads a pre-built tarball or the repo and links `vp` into `~/.local/bin` or `/usr/local/bin`.
- **Pros:** No npm required; can bundle a Node runtime or rely on system Node; feels like typical CLI tools.
- **Cons:** Must maintain install script, signing/checksums, and platform-specific builds if bundling Node.

### C. Homebrew formula

- **How:** `brew install tan-yong-sheng/tap/vision-proxy`.
- **Pros:** Native macOS/Linux experience, automatic updates via `brew upgrade`.
- **Cons:** Requires a Homebrew tap and formula maintenance; still usually downloads an npm-based or prebuilt artifact under the hood.

### D. OS packages (deb/rpm/etc.)

- **How:** Build platform-native packages.
- **Pros:** Best integration for system administrators.
- **Cons:** High maintenance overhead; probably overkill at current scale.

## Decision (2026-08-15)

Avoid npm. Ship from **GitHub Releases** as the artifact source of truth, then offer two install paths - a **Homebrew tap** and a **curl installer** - that both pull the same release tarballs. This matches the "just download it" goal without a registry dependency.

Two tracks for what the release actually contains:

- **Track A - JS dist + Node dependency (recommended now):** publish the existing `tsc` build (`dist/`) as per-OS/arch tarballs. Users need Node 22+ (Homebrew `depends_on "node@22"`; curl installer documents `node >= 22`). Reuses `npm run build` with no new tooling.
- **Track B - standalone binary (optional fast-follow):** `bun build ./src/cli.ts --compile --outfile vp` produces a true single binary with the runtime embedded (no Node needed), cross-compiled for `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64/x64`, `bun-windows-x64`. Caveat: `@napi-rs/keyring` is a native `.node` addon loaded lazily and degrades to `null` when missing - bun compile may not bundle it, so keep keyring optional/guarded (already is) or mark it external.

Homebrew formula (same repo): keep the formula in this repo under `Formula/vision-proxy.rb`. Users tap with the explicit URL: `brew tap tan-yong-sheng/vision-proxy https://github.com/tan-yong-sheng/vision-proxy`, then `brew install tan-yong-sheng/vision-proxy/vision-proxy`. The formula `url` points at the release tarball + `sha256` + `version`; `bin.install "vp"`; `depends_on "node@22"` for Track A.

Curl installer (`scripts/install.sh`): query `api.github.com/repos/<owner>/<repo>/releases/latest`, pick the asset by `uname`/`arch`, download, verify `sha256sum` against a published checksum, extract to `~/.local/share/vision-proxy`, symlink `vp` into `~/.local/bin`.

Hook shim `vp` discovery: at install time, `vp integration install` captures its own invocation path (`process.argv[1]`) and writes it into the generated shim. The shim uses that embedded absolute path, falling back to `vp` via PATH if the embedded path disappears. No env var is required for the common case.

## Open questions (remaining)

1. ~~Hook shim `vp` discovery~~ - **Decided:** embed absolute path at install time, fallback to PATH.
2. ~~`vp config set binPath` / `VISION_PROXY_PATH`~~ - **Decided:** skip for now; embedded path + PATH fallback is sufficient.
3. ~~Distribution Track~~ - **Decided:** commit to Track A now; defer Track B to a later worktree.

## Proposed next step

- **Short term (Track A):** add a GitHub Actions release workflow that builds `dist/` per OS/arch and uploads tarballs + checksums; add `scripts/install.sh` (curl route) and the Homebrew formula in `Formula/vision-proxy.rb`; update README install section.
- **Fast-follow (Track B):** evaluate `bun build --compile`, resolve the `@napi-rs/keyring` native-addon caveat, then add prebuilt binaries to the same releases.
- Apply the binary-discovery decision in `backend-fix-hook-shim-shared-mjs-copy.md`.

## Worktree strategy

- Single worktree: `vp-distribution` off `main`.
- **Batch:** `vp-distribution` (phase 2, stack_position 2).
- **Depends on:** phase 1 worktrees - bug fixes (`backend-prune-max-tool-calls-per-turn.md`, `backend-fix-pi-extension-typebox-dependency.md`) and tooling (`backend-tooling-biome-betterleaks.md`). Runs in parallel with the phase 2 `vp-qa-fixes` batch (bug fixes #1/#4); that batch edits `src/commands/integration.ts` while this touches release/Homebrew/install/README files only.
- **Worktree doc:** `../worktrees/backend-vp-distribution.md`.

## Coupling to active bug fixes

- The packaged layout must keep `dist/shims/*.mjs` (hook shims + `shared.mjs`) together with the binary, or finding #4's missing-`shared.mjs` failure resurfaces in the distributed artifact. Tracked in `../plans/backend-fix-hook-shim-shared-mjs-copy.md`.
- Finding #1 (`uninstall pi` message) is independent of packaging.

## Tools / MCP / Skills

- GitHub Releases (tarballs + checksums) as the artifact source.
- Homebrew formula kept in this repo under `Formula/vision-proxy.rb`.
- `bun build --compile` for Track B standalone binaries.
- `curl` + `jq` + `sha256sum` for the installer.

## Deliverables

1. GitHub Actions release workflow building per-OS/arch tarballs of `dist/` + checksum files.
2. Homebrew formula in `Formula/vision-proxy.rb` (`url` = release tarball, name `vision-proxy`).
3. `scripts/install.sh` curl installer with checksum verification.
4. README install section covering Homebrew + curl (no npm publish).
5. Optional (Track B): `bun build --compile` standalone binaries.
