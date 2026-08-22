# AGENTS.md

This file gives coding agents project-specific context.
Keep it short and update it when workflows change.

## Project Overview

- **Name:** `vision-proxy` (npm package `vision-proxy`, formerly `pi-vision-proxy`) - portable CLI that routes images to a vision-capable model and prints fenced, UNTRUSTED descriptions.
- **Purpose:** Lets any coding agent "see" images by calling the CLI from UserPromptSubmit hooks.
- **Registry:** Published as `vision-proxy` on npm.
- **Package keyword:** `pi-package`.
- **Runtime:** Node 22+ (uses `--experimental-strip-types` for native TypeScript).

## Main entry points

| Entry | File | Purpose |
|-------|------|---------|
| CLI binary | `src/cli.ts` | `vp` / `vision-proxy` command entry point. |
| Pi-free core | `src/core.ts` | Config, env overrides, image loading/hashing, fencing, and provider dispatch. No Pi runtime deps. |
| AI SDK adapter | `src/adapter.ts` | Vercel AI SDK `generateText` wrapper for image payloads. |
| CLI commands | `src/commands/*.ts` | `analyze`, `config`, `provider`, `cache`, and `hook` subcommands. |
| Hook dispatcher | `src/commands/hook.ts` | Claude Code and Codex hook dispatcher (`vp hook`). |
| Keyring storage | `src/keyring.ts` | Optional `@napi-rs/keyring` OS keyring credential storage. |

## Important directories

- `src/` - CLI source and Pi-free core.
- `src/commands/` - CLI subcommands.
- `src/commands/hook.ts` - Agent hook dispatcher (`vp hook`).
- `scripts/` - Installer and launcher helpers (`install.sh`, `vp`).
- `.claude/hooks/` - Generated fallow gate hook.
- `.github/workflows/` - CI workflows (ci.yml, release.yml, osv-scanner-pr.yml, osv-scanner-scheduled.yml).

## Architecture Notes

- **Module boundary:** `src/core.ts` is the Pi-free core - pure functions and no peer-dep runtime requirements.
`src/adapter.ts` calls the Vercel AI SDK.
`src/commands/*.ts` wire CLI arguments to `src/core.ts` and `src/adapter.ts`.
`src/commands/hook.ts` (the `vp hook` subcommand) dispatches agent hooks with no runtime dependencies; it shells out to the `vp` binary.
- **Generated code:** `.fallow/cache.bin` is fallow cache data - do not edit manually.
`.claude/hooks/fallow-gate.sh` is a generated hook wrapper.
- **Sensitive areas:** `src/adapter.ts` and `src/commands/analyze.ts` make actual API calls to external vision models.
`src/core.ts` handles provider API keys and image payloads.
`src/keyring.ts` reads and writes OS keyring credentials.
Both are adjacent to real API keys and external model endpoints.
- **Config:** The CLI uses `.vision-proxy.json` (project) and `~/.vision-proxy/config.json` (user), with a legacy fallback to `~/.pi/agent/vision-proxy.json`.
Environment overrides use `VP_*`.
- **Test isolation:** Tests use `mkdtemp` for isolated temp directories.
- **Build step:** `npm run build` compiles `src/` to `dist/`.

## Commands

| Action | Command |
|--------|---------|
| Install (global CLI) | `npm install -g .` or `npm link` |
| Test | `npm test` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Fallow audit | `fallow audit --format json --quiet` |
| OSV-Scanner (PR) | `.github/workflows/osv-scanner-pr.yml` - scans for newly introduced dependency CVEs |
| OSV-Scanner (scheduled) | `.github/workflows/osv-scanner-scheduled.yml` - weekly full scan with SARIF upload |
| BetterLeaks | `pnpm secrets` - scans for accidental secret exposure |

Runtime requirements:

- Node 22+ (required for `--experimental-strip-types`)

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
`.claude/hooks/fallow-gate.sh` - it's a generated hook; edit `src/core.ts` for sanitization/fencing behavior and `src/commands/analyze.ts` for analysis behavior.
- **Always ask before:** Adding new production dependencies to `package.json` - current deps are minimal and chosen deliberately.
Changing `VP_*` env var names - they must stay in sync with `src/core.ts`, `src/cache.ts`, `src/keyring.ts`, and `src/commands/hook.ts`.
- **Preferred style:** Pure functions in `src/core.ts` and `src/commands/*.ts` with type-only imports from peer deps.
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
