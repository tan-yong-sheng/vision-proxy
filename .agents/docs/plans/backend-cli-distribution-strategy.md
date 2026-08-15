---
type: plan
title: "CLI distribution strategy"
description: "Decide how users install the vision-proxy CLI globally and how the hook shims find the binary."
area: backend
tags: [cli, distribution, packaging, npm, homebrew, install]
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

## Open questions

1. Is publishing to npm acceptable, or do we want a curl-based route to avoid registry dependency?
2. Should we bundle Node with the CLI, or require Node 22+ to be pre-installed?
3. How do hook shims locate `vp` reliably?
   - Option 1: rely on `PATH`.
   - Option 2: embed the absolute path to `vp` at install time.
   - Option 3: support `$VP_BIN` / `$VISION_PROXY_PATH` env override (already partially supported via `VP_BIN`).
4. Should `vp config set` support a `vpPath` / `binPath` key that records where the binary lives, so hooks can read it from config?

## Proposed next step

- **Short term:** document the existing `npm install -g .` / `npm link` flow and make the hook shims use `VP_BIN` if set.
- **Medium term:** publish to npm so `npm install -g vision-proxy` works, then add a Homebrew tap.
- **Decision needed:** whether to add `vp config set binPath <path>` (or `VISION_PROXY_PATH` env) so hooks can resolve `vp` even when it is not on `PATH`.

## Worktree strategy

- Single worktree: `vp-distribution` off `main`.
- Depends on: none (can be done in parallel with post-merge QA fixes).

## Tools / MCP / Skills

- `npm publish` for registry publishing.
- GitHub Releases for curl-install tarballs.
- Homebrew tap repo under `tan-yong-sheng/homebrew-tap`.

## Deliverables

1. Updated README install section.
2. npm publish workflow (if chosen).
3. Install shell script and GitHub release artifacts (if curl route chosen).
4. Homebrew formula (if chosen).
5. Optional: `vp config set binPath` and hook shim lookup using config/env.
