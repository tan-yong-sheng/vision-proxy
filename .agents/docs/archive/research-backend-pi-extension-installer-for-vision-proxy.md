---
type: research
title: Pi extension installer for vision-proxy
description: "Research how to add a `vp integration install pi` command that wires the CLI into Pi as an extension."
area: backend
tags: []
status: complete
superseded_by: ../plans/backend-vision-proxy-post-migration-feature-set.md
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-09-13"
related: []
---
# Pi extension installer for vision-proxy

## Question

What is the smallest, most maintainable way for `vp integration install pi` to give Pi users an `analyze_image` tool backed by the standalone `vision-proxy` CLI?

## Findings

### Current state

- The original `pi-vision-proxy` Pi extension was dropped in the migration.
- `vision-proxy` is now a CLI-only package; hooks for Claude Code and Codex already exist under `src/shims/`.
- Pi auto-discovers extensions from `~/.pi/agent/extensions/*.ts` (global) and `.pi/extensions/*.ts` (project-local).
- Pi packages can also be installed via `pi install` using a `package.json` with the `pi-package` keyword and a `pi.extensions` manifest.

### Option A: single-file extension copied into Pi's extensions directory

`vp integration install pi` generates and writes a TypeScript file such as `~/.pi/agent/extensions/vision-proxy.ts`. The file imports `@earendil-works/pi-coding-agent` and `typebox`, registers an `analyze_image` tool, and shells out to `vp analyze --json`.

- **Pros**:
  - No separate package or build step required.
  - Uses Pi's native auto-discovery.
  - Uninstall is just deleting the file.
- **Cons**:
  - The generated file is a snapshot; updating it requires re-running `vp integration install pi` after each CLI upgrade.
  - Depends on `vp` being on `PATH` (or uses a hardcoded absolute path at install time).
  - Mixes Pi-specific code into the CLI repo as a template/embedded string.

### Option B: separate `packages/vp-pi-extension` workspace package

Re-introduce a Pi extension as a sibling package (e.g., `packages/vp-pi-extension`) with its own `package.json`, `pi-package` keyword, and `pi.extensions` manifest. `vp integration install pi` could run `pi install ./packages/vp-pi-extension`.

- **Pros**:
  - Idiomatic Pi packaging; can be published to npm independently.
  - Clean separation between CLI and Pi integration.
  - Can include commands, tools, and prompts without bloating the CLI package.
- **Cons**:
  - Adds monorepo/workspace complexity.
  - Requires the `pi` CLI to be installed locally for the command to work unattended.
  - The standalone CLI would need to spawn `pi install`, which may fail in non-interactive environments.

### Option C: restore Pi extension files inside the main package

Bring back `extensions/vision-proxy.ts` and `lib/` in the main package, keep the `pi-package` keyword, and let users run `pi install ./` or `pi install npm:vision-proxy`.

- **Pros**:
  - Matches the pre-migration install flow.
- **Cons**:
  - Re-introduces Pi peer dependencies (`@earendil-works/pi-coding-agent`, `typebox`) and coupling the migration intentionally removed.
  - Conflicts with the goal of a Pi-free CLI core.

### Option D: project-local shim only

Install the extension into `.pi/extensions/vision-proxy.ts` instead of the global Pi directory.

- **Pros**:
  - Scoped to the current project, reproducible in repo dotfiles.
- **Cons**:
  - Only useful after project trust is granted.
  - Users likely want global availability so every Pi session can analyze images.

### Recommended approach

Start with **Option A**: a global single-file extension written by `vp integration install pi`.

- Add a new top-level command group `vp integration <install|uninstall|show> <agent>` where `agent` initially only supports `pi`.
- Embed the Pi extension source as a template string (or read it from a built asset under `dist/pi-extension.ts`).
- The generated extension:
  - registers an `analyze_image` tool that forwards to `vp analyze`;
  - reads `VP_BIN` from the environment, falling back to `vp` on `PATH`;
  - respects `~/.vision-proxy/config.json` implicitly because `vp` resolves it;
  - allows an explicit API key via `--api-key` only if the Pi tool call supplies one (otherwise relies on env/keyring).
- Provide `vp integration uninstall pi` to remove the file.
- Provide `vp integration show pi` to print the extension source for manual review.
- Keep the door open for Option B later if the Pi integration grows beyond a single tool.

### Implementation notes

- The extension must be plain TypeScript that Pi's `jiti` loader can run without a separate build.
- Tool schema can use `Type.Object({ ... })` from `typebox`, which Pi bundles for extensions.
- The extension should fail-open: if `vp` is missing or exits non-zero, return a clear error message in the tool result.

## Open questions

1. Should the installer target global Pi (`~/.pi/agent/extensions/`) by default, or offer a `--project` flag for `.pi/extensions/`?
2. Should the generated Pi extension also perform `before_agent_start` image stripping/replacement, or only expose the explicit `analyze_image` tool?
3. How should the installer behave when Pi is not installed (e.g., warn and print manual instructions)?
4. Should the generated extension hardcode the absolute path to the `vp` binary discovered at install time, or always rely on `PATH`/`VP_BIN`?
5. Is there a need to support Pi's `settings.json` package entry instead of (or in addition to) dropping a file into the extensions directory?
