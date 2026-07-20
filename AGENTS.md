# AGENTS.md

This file gives coding agents project-specific context. Keep it short and update it when workflows change.

## Project Overview

- **Name:** `pi-vision-proxy` — Pi extension that provides automatic image description for any model
- **Purpose:** Routes images to a vision-capable model and injects descriptions into context as a proxy. Acts when the active model lacks native image support.
- **Registry:** Published as `pi-vision-proxy` on npm
- **Package keyword:** `pi-package`
- **Runtime:** Node 22+ (uses `--experimental-strip-types` for native TypeScript)

## Main entry points

| Entry | File | Purpose |
|-------|------|---------|
| Extension default export | `extensions/vision-proxy.ts` | Main extension: `export default function(pi: ExtensionAPI)` — registers `analyze_image`, `analyze_image` tools and `commandHandler` for `/vision-proxy` commands |
| Pure helpers (type-safe) | `extensions/internal.ts` | Pure functions extracted for testability — crop resolution, config, hashing, image parsing, fencing, sanitization. No peer-dep runtime requirements |
| Unit tests | `extensions/__tests__/internal.test.ts` | Tests for pure helpers (no real API calls or Pi runtime) |
| Integration tests | `extensions/__tests__/integration.test.ts` | Full wiring tests: fence output, consent, tool validation, context stripping, telemetry |

## Important directories

- `extensions/` — Main source code for the extension
- `extensions/__tests__/` — Unit and integration test files
- `extensions/internal.ts` — Pure helper functions (type-only imports, no runtime deps)
- `extensions/vision-proxy.ts` — Extension wiring (tool registration, command handler, response builder)
- `.fallow/` — Fallow audit cache
- `.claude/hooks/` — Claude Code pre-tool hook for fallow gate

## Architecture Notes

- **Module boundary:** `vision-proxy` (extension layer) → `internal` (pure helpers). `vision-proxy` imports everything from `internal`; `internal` has zero imports back. `internal` is the high-fan-in core layer.
- **Generated code:** `.fallow/cache.bin` is fallow cache data — do not edit manually. `.claude/hooks/fallow-gate.sh` is a generated hook wrapper.
- **Sensitive areas:** `extensions/vision-proxy.ts` — the `handleAnalyzeImage` function (line 575–881) is the core tool handler. `analyzeImages` (line 445–571) makes actual API calls to external vision models. Both are adjacent to real API keys and external model endpoints.
- **Config is not vendored:** No `.pi/` or `.pi/vision-proxy.json` exists — persistent config is written to the system's `~/.pi/agent/vision-proxy.json` path.
- **Test isolation:** Tests use `mkdtemp` for isolated temp directories. No build step needed.
- **Fallow gate:** Pre-commit audit via `.claude/hooks/fallow-gate.sh` — blocked on `fallow` being on PATH.

## Commands

| Action | Command |
|--------|---------|
| Install (local) | `pi install ./packages/pi-vision-proxy` (or `npx pi install` from registry) |
| Test (unit) | `node --experimental-strip-types --no-warnings --test extensions/__tests__/internal.test.ts` |
| Test (integration) | `node --experimental-strip-types --no-warnings --test extensions/__tests__/integration.test.ts` |
| Test all | `node --experimental-strip-types --no-warnings --test extensions/__tests__/*.test.ts` |
| Typecheck | `npx tsc --noEmit` (requires `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` types) |
| Fallow audit | `fallow audit --format json --quiet` |

Runtime requirements:
- Node 22+ (required for `--experimental-strip-types`)
- Peer deps: `@earendil-works/pi-ai >=0.74.0`, `@earendil-works/pi-coding-agent >=0.74.0`

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

- **Do not edit:** `.fallow/cache.bin` — it's fallow binary cache data, not source. `.claude/hooks/fallow-gate.sh` — it's a generated hook; edit `extensions/internal.ts` if you need to change sanitization or fencing behavior.
- **Always ask before:** Adding new production dependencies to `package.json` — current deps are minimal and chosen deliberately (image-size, imagescript, imghash). Changing `PI_VISION_PROXY_*` env var names — they must stay in sync with `extensions/internal.ts`.
- **Preferred style:** Pure functions in `extensions/internal.ts` with type-only imports from peer deps. No side effects at module scope. Tests use `node:test` and `node:assert` — no test runner dependency. Exported helpers get `@tags` JSDoc. Internal helpers get standard `/** */` JSDoc. Types before implementation.

---

<!-- fallow:setup-hooks:start -->
## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking.

Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. Inherited findings on touched files are reported under `attribution` and annotated with `introduced: false`, but do not block the commit. Set `[audit] gate = "all"` in `fallow.toml` to gate every finding in changed files.

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
