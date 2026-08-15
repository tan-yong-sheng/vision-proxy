---
type: research
title: integration status command
description: "Design a `vp integration status` command that reports whether vision-proxy integrations and hooks are installed, current, or outdated, similar to `herdr integration status`."
area: backend
tags:
  - integration
  - hook
  - status
  - version
  - herdr
  - pi
  - claude-code
  - codex
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-09-14"
related: [./backend-pi-hook-versus-integration-support.md]
---
# integration status command

## Question

Should vision-proxy support `vp integration status` like `herdr integration status`?
The goal is to let users check whether the Pi extension and the Claude Code / Codex UserPromptSubmit hooks are installed, and to warn when an installed file is older than the version shipped with the current `vp` binary.

## Findings

### 1. Vision-proxy already has two related command families

`src/commands/integration.ts` handles the Pi extension model:
- `vp integration install pi` writes `~/.pi/agent/extensions/vision-proxy.ts` from the embedded `PI_EXTENSION_SOURCE` template.
- `vp integration show pi` prints the embedded extension source.
- `vp integration uninstall pi` removes the extension file.

`src/commands/hook.ts` handles UserPromptSubmit shims for agents that expose hook configs:
- `vp hook install claude-code` edits `~/.claude/settings.json` and copies `claude-code-user-prompt-submit.mjs` next to the binary.
- `vp hook install codex` edits `~/.codex/config.toml` and copies `codex-user-prompt-submit.mjs` next to the binary.
- `vp hook list` already shows a simple checkmark per supported agent by reading the agent config and looking for the `vision-proxy` marker.
- `vp hook show <agent>` and `vp hook uninstall <agent>` exist.

There is no status/update-detection command for either family today.

### 2. Herdr's `integration status` is the closest reference

Herdr (`src/integration/mod.rs` and `src/cli/integration.rs`) treats integrations as embedded assets with a version marker:
- Each asset contains a comment like `HERDR_INTEGRATION_VERSION=1`.
- The CLI knows an `expected_version` constant for each target.
- `integration_status_at` reads the installed file, parses the marker, and classifies the state as:
  - `NotInstalled`
  - `Current` (installed version >= expected version)
  - `Outdated` (file exists but version is missing/lower)
- `herdr integration status` prints one line per target:
  - `<target>: current (vN) (<path>)`
  - `<target>: outdated (vN < vM) (<path>)`
  - `<target>: not installed (<path>)`
- `herdr integration status --outdated-only` prints a compact update notice and exits 0 even when there is nothing to report.
- Herdr also tracks whether the target agent binary is on `PATH` to decide whether to recommend installation.

### 3. Vision-proxy has no version markers yet

- `PI_EXTENSION_SOURCE` in `src/pi-extension.ts` does not contain a version marker.
- The hook shims (`src/shims/claude-code-user-prompt-submit.mjs`, `src/shims/codex-user-prompt-submit.mjs`, `src/shims/shared.mjs`) do not contain a version marker.
- The CLI version is hard-coded as `VERSION = "0.1.0"` in `src/cli.ts`, but it is neither exported nor embedded in integration/hook assets.

Without a marker, the only status we can report today is installed/not-installed.
Detecting outdated installs requires adding a marker to each shipped asset first.

### 4. Status detection for hooks is config-based, not file-based

For Claude Code and Codex, the integration is not a single asset file like Pi's extension.
Instead, the hook shim file is copied next to the `vp` binary, and a config entry pointing at that shim is added to the agent's config.

This means a "version" for hooks has at least two parts:
- The shim file content (can carry a marker).
- The config block shape (e.g. timeout, additionalContextLimit).

If the shim is updated but the config block shape is unchanged, a marker inside the shim is enough.
If a future update needs a different config block, the status check would also need to parse the config and compare structure.

For the first implementation, a marker inside the shim plus a "marker present in config" check is sufficient.

### 5. Design options

#### Option A: Add status only to `vp integration`

Add `vp integration status [pi]` that reports only the Pi extension.

Pros:
- Minimal scope.
- Aligns with the existing `vp integration` subcommand.
- Mirrors `herdr integration status` for the Pi target.

Cons:
- Does not address hook status, which is what many users will care about for Claude Code and Codex.
- Leaves `vp hook list` as the only hook status tool, and it already reports installed/not-installed but never outdated.

#### Option B: Add status to both command families

Add `vp integration status [pi]` and `vp hook status [claude-code|codex]`.

Pros:
- Each command stays responsible for its own integration model.
- `vp hook status` can reuse the same marker logic as `vp integration status`.

Cons:
- Users have to run two commands to see the full picture.
- Naming is inconsistent: `vp hook list` already exists but does not show versions.

#### Option C: `vp integration status` reports everything, `vp hook status` is added as an alias/detail view

Make `vp integration status` the unified entry point that lists Pi, Claude Code, and Codex statuses, even though hooks are managed by `vp hook`.

Pros:
- One command answers the user's actual question: "are my agent integrations up to date?"
- Matches the spirit of `herdr integration status`, which lists every target.

Cons:
- Slightly blurs the line between extensions and hooks.
- Requires `src/commands/integration.ts` to know about hook specs, or to call into `src/commands/hook.ts` internals.

#### Option D: A new top-level `vp status` command

Add `vp status` that reports integrations, hooks, provider keys, and cache health in one view.

Pros:
- Unified health dashboard.
- Scales to future status sources.

Cons:
- Larger scope than the user asked for.
- Mixes unrelated concerns (API keys, cache, hooks, extensions).

## Conclusion

**Recommend Option C with Option B as the implementation path.**

The user-facing command should be `vp integration status` (with an optional `--outdated-only` flag like herdr), because that is the command they asked for and it is the natural place to answer "are my coding-agent integrations installed and up to date?".

Implementation steps:
1. Add a version marker to `PI_EXTENSION_SOURCE` (e.g. `VISION_PROXY_INTEGRATION_VERSION=1`).
2. Add a version marker to each hook shim (e.g. `VISION_PROXY_HOOK_VERSION=1`).
3. Export or centralize the CLI version / asset versions so `integration status` can compare installed vs expected.
4. Implement status detection:
   - Pi: file exists + parse marker.
   - Claude Code: `~/.claude/settings.json` contains the `vision-proxy` marker + shim file exists and marker matches expected.
   - Codex: `~/.codex/config.toml` contains the `vision-proxy` marker + shim file exists and marker matches expected.
5. Wire `vp integration status` in `src/cli.ts` and update help text.
6. Optionally add `vp hook status` that delegates to the same detector but filters to hook targets.

## Open questions

- Should the version marker be an integer (herdr-style) or the npm package version (e.g. `0.1.0`)?
nInteger markers are simpler for "current/outdated" semantics, but package version is more human-readable.
- Should `vp integration install pi` refuse to overwrite a newer version with an older one?
nHerdr overwrites blindly; we could warn instead.
- Should `vp integration status` also check whether the target agent binary is on `PATH`, like herdr does?
nThis is useful for recommendations but not strictly required for the initial feature.
- Should we unify `vp hook` into `vp integration` long-term, or keep the separate `vp hook` command?
nThe existing research `backend-pi-hook-versus-integration-support.md` argues that Pi belongs under `integration` because it is an extension, not a hook. Keeping `hook` for UserPromptSubmit shims and `integration` for extensions is probably the right split, but a unified status view is still valuable.
