# AGENTS.md

This file gives coding agents project-specific context.
Keep it short and update it when workflows change.

## Project Overview

- **Name:** `vision-proxy` (npm package `vision-proxy`, formerly `pi-vision-proxy`) - portable CLI that routes images to a vision-capable model and prints fenced, UNTRUSTED descriptions.
- **Purpose:** Lets any coding agent "see" images by calling the CLI from UserPromptSubmit hooks.
The Pi extension (`extensions/vision-proxy.ts`) remains for backward compatibility and can still inject descriptions when the active model lacks image support.
- **Registry:** Published as `vision-proxy` on npm.
- **Package keyword:** `pi-package`.
- **Runtime:** Node 22+ (uses `--experimental-strip-types` for native TypeScript).

## Main entry points

| Entry | File | Purpose |
|-------|------|---------|
| CLI binary | `src/cli.ts` | `vp` / `vision-proxy` command entry point. |
| Pi extension | `extensions/vision-proxy.ts` | Default export registers the `analyze_image` tool, the `/vision-proxy` command, and image stripping. |
| Pi-free core | `src/core.ts` | Config, env overrides, image loading/hashing, fencing, and provider dispatch. No Pi runtime deps. |
| Shared extension library | `lib/shared.ts` | State and helpers shared between the extension and CLI adapter. |
| CLI commands | `src/commands/*.ts` | `analyze`, `config`, `provider`, `cache`, and `hook` subcommands. |
| Hook shims | `src/shims/*.mjs` | Claude Code and Codex UserPromptSubmit hook shims. |
| Before-agent handler | `extensions/helpers/before-agent.ts` | Pi `before_agent_start` event handler. |

## Important directories

- `src/` - CLI source and Pi-free core.
- `src/commands/` - CLI subcommands.
- `src/shims/` - Agent hook shims (copied to `dist/` at build time).
- `lib/` - Shared modules used by the Pi extension.
- `extensions/` - Pi extension wiring and helpers.
- `extensions/__tests__/` - Extension unit and integration tests.
- `scripts/` - Build helpers (`copy-shims.mjs`).
- `.claude/hooks/` - Generated fallow gate hook.

## Architecture Notes

- **Module boundary:** `src/core.ts` is the Pi-free core - pure functions and no peer-dep runtime requirements.
The Pi extension (`extensions/vision-proxy.ts`) wires `lib/*` helpers and `extensions/helpers/before-agent.ts`.
`lib/commands.ts` imports config helpers from `extensions/internal.ts`; `extensions/vision-proxy.ts` imports shared logic from `lib/*`.
- **Generated code:** `.fallow/cache.bin` is fallow cache data - do not edit manually.
`.claude/hooks/fallow-gate.sh` is a generated hook wrapper.
`scripts/copy-shims.mjs` copies hook shims into `dist/` during `npm run build`.
- **Sensitive areas:** `lib/analyze.ts` (`analyzeImages`, `handleAnalyzeImage`) makes actual API calls to external vision models.
`src/core.ts` handles provider API keys and image payloads.
Both are adjacent to real API keys and external model endpoints.
- **Config:** The CLI uses `.vision-proxy.json` (project) and `~/.vision-proxy/config.json` (user), with a legacy fallback to `~/.pi/agent/vision-proxy.json`.
The Pi extension still reads/writes `~/.pi/agent/vision-proxy.json`.
Environment overrides use `VP_*` in the CLI and `PI_VISION_PROXY_*` in the extension.
- **Test isolation:** Tests use `mkdtemp` for isolated temp directories.
- **Build step:** `npm run build` compiles `src/` to `dist/` and copies shims.

## Commands

| Action | Command |
|--------|---------|
| Install (global CLI) | `npm install -g .` or `npm link` |
| Install (Pi extension) | `pi install ./` |
| Test | `npm test` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Fallow audit | `fallow audit --format json --quiet` |

Runtime requirements:

- Node 22+ (required for `--experimental-strip-types`)
- Peer deps (Pi extension only): `@earendil-works/pi-ai >=0.74.0`, `@earendil-works/pi-coding-agent >=0.74.0`, `typebox *`

## Fallow

- Use `fallow audit --format json --quiet` before committing AI-generated changes.
- Use `fallow dead-code --format json --quiet`, `fallow dupes --format json --quiet`, and `fallow health --format json --quiet` for targeted checks.
- Use `fallow list --entry-points --format json --quiet` and `fallow list --boundaries --format json --quiet` to inspect project shape.

<!-- generated:task-matrix:start -->
| When the agent is about to... | Run |
|---|---|
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| prioritize refactoring | `fallow health --hotspots --targets` |
| ask who owns code | `fallow health --ownership` |
| check untested-but-reachable code | `fallow health --coverage-gaps` |
| consolidate duplication | `fallow dupes --trace dup:<fingerprint>` |
| find feature flags | `fallow flags` |
| surface security candidates | `fallow security` |
| understand a finding | `fallow explain <issue-type>` |
| scope a monorepo | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |
<!-- generated:task-matrix:end -->

## Agent Rules

- **Do not edit:** `.fallow/cache.bin` - it's fallow binary cache data, not source.
`.claude/hooks/fallow-gate.sh` - it's a generated hook; edit `src/core.ts` for CLI sanitization/fencing behavior and `extensions/internal.ts` for extension behavior.
- **Always ask before:** Adding new production dependencies to `package.json` - current deps are minimal and chosen deliberately.
Changing `VP_*` env var names - they must stay in sync with `src/core.ts`.
Changing `PI_VISION_PROXY_*` env var names - they must stay in sync with `extensions/internal.ts`.
- **Preferred style:** Pure functions in `src/core.ts` and `extensions/internal.ts` with type-only imports from peer deps.
No side effects at module scope.
Tests use `node:test` and `node:assert` - no test runner dependency.
Exported helpers get `@tags` JSDoc.
Internal helpers get standard `/** */` JSDoc.
Types before implementation.

---

<!-- fallow:setup-hooks:start -->
## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`.
If the verdict is `fail`, fix the reported findings before retrying.
Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking.

Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.
Inherited findings on touched files are reported under `attribution` and annotated with `introduced: false`, but do not block the commit.
Set `[audit] gate = "all"` in `fallow.toml` to gate every finding in changed files.

For non-skill agents, treat the task map below as the local onboarding source: run the listed fallow command before destructive edits, before commits, and before pull request handoff.

## Fallow task map

| When the agent is about to... | Run |
|---|---|
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| prioritize refactoring | `fallow health --hotspots --targets` |
| ask who owns code | `fallow health --ownership` |
| check untested-but-reachable code | `fallow health --coverage-gaps` |
| consolidate duplication | `fallow dupes --trace dup:<fingerprint>` |
| find feature flags | `fallow flags` |
| surface security candidates | `fallow security` |
| understand a finding | `fallow explain <issue-type>` |
| scope a monorepo | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |
<!-- fallow:setup-hooks:end -->
