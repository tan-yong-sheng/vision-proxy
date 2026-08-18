---
type: worktree
title: "Phase 1: Prototype spike"
description: "Phase 1: Prototype spike - implementation track for add pretooluse read hook."
area: backend
tags: []
status: active
created: "2026-08-17"
updated: "2026-08-17"
stale_after: "2026-08-31"
branch: feat/add-pretooluse-read-hook
stack_position: 1
stack_batch: hook
related: [../plans/backend-add-pretooluse-read-hook.md]
---
# Phase 1: Prototype spike

## Objective

Validate that a minimal `vp hook` binary can inject `additionalContext` into both Claude Code and Codex model context before committing to the full install/uninstall rewrite.

## Scope

- Build a throwaway `vp hook` that emits a fake `additionalContext` string.
- Temporarily wire it into `src/cli.ts`.
- Manually install the hook in Claude Code and Codex.
- Test `UserPromptSubmit` and `PreToolUse Read` events.
- Record pass/fail results.

## Tasks

- [ ] Create a throwaway `vp hook` prototype in `src/commands/hook.ts` that emits a static/fake `additionalContext` string (no real `vp analyze` call yet).
- [ ] Wire it temporarily into `src/cli.ts`.
- [ ] Manually install the hook in Claude Code `~/.claude/settings.json` with the absolute `vp` path.
- [ ] Manually install the hook in Codex `~/.codex/hooks.json` with the absolute `vp` path.
- [ ] Test `UserPromptSubmit`: submit a prompt mentioning an image path; verify the fake context appears in the agent's context.
- [ ] Test `PreToolUse Read`: ask the agent to read an image file; verify the fake context appears before/after the tool result.
- [ ] Record results in a QA dossier or update this plan.

## Verification

npm test

## Status

- [x] Worktree created
- [x] Implementation complete (throwaway prototype)
- [~] Tests pass (unit-level functional check done; live agent run blocked by sandbox)
- [ ] Landed on feature branch (ready for PR/merge)

## Results

### What was built

- `src/commands/hook.ts` (throwaway): reads the hook event JSON from stdin, routes
  on `hook_event_name` / `hookEventName`, and emits a fake `additionalContext`
  string for `UserPromptSubmit` and `PreToolUse Read(image_path)`. No real
  `vp analyze` call. Fail-open on unrecognized events / non-image reads / parse errors.
- `src/cli.ts`: added `case "hook"` that calls `runHook()` (no subcommand routing yet).
- `npm run build` produces `dist/cli.js` successfully (typecheck + copy-shims).
- Project-level hook configs written inside the worktree for a contained live test:
  - `.claude/settings.json` (UserPromptSubmit + PreToolUse matcher `Read`)
  - `.codex/hooks.json` (same shape)

### Verified (functional, offline)

Drove the built binary directly with representative stdin payloads:

- `UserPromptSubmit` with an image path in the prompt -> emits
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`.
- `PreToolUse` + `tool_name: "Read"` + image `file_path` -> emits
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"..."}}`.
- `PreToolUse` + `Read` on a non-image (`notes.txt`) -> no output (correct fail-open).
- `PreToolUse` + non-`Read` tool (`Write`) -> no output (correct fail-open).

### NOT verified (blocked)

Codex live test could not be run from this sandbox session:

- The nono sandbox denies execution of the `codex` binary
  (`/home/tys203831/.codex/packages/...` is not a granted executable path) and
  denies writes to `~/.codex/hooks.json`. The `codex` binary is a native ELF
  (cannot be launched via `node` either).
- Therefore the Codex-side "does the injected `additionalContext` reach the model"
  is UNVERIFIED at runtime. The output shape is correct and matches the codex-rs
  schema from the research notes, but the live injection path was not exercised for
  Codex.

### VERIFIED LIVE (Claude Code)

User-level install succeeded (write to `~/.claude/settings.json` is permitted;
backup at `~/.claude/settings.json.bak-vpspike`). The `claude` binary is
executable from this session. Ran two real `claude -p` sessions:

1. **UserPromptSubmit** - prompt mentioned `/tmp/vp-spike/screenshot.png`. The
   session quoted back verbatim:
   `[vision-proxy] UNTRUSTED description of /tmp/vp-spike/screenshot.png: A
   prototype placeholder image showing a test pattern with colored bars and a
   timestamp overlay. (SPIKE: not a real vision-model description.)`
   => additionalContext reached the model. PASS.

2. **PreToolUse Read** - asked the agent to Read the image file. The session
   reported the `[vision-proxy]` line appeared "in the PreToolUse:Read hook
   context surrounding the read" (plus once in the prompt context). => injection
   around the Read tool call works. PASS.

Conclusion: the architecture is proven for Claude Code end-to-end. Codex needs a
live run outside the sandbox (allow the codex binary + `~/.codex/hooks.json`
write) to close its half of the spike.

### Codex `hooks.json` resolution (from codex-rs source)

`config_folder()` (state.rs:219) returns the `.codex/` folder for a `Project` layer,
and `hooks_config_folder()` joins `hooks.json` onto it (discovery.rs:340). So a
project-level `.codex/hooks.json` next to the repo root is honored by Codex, which
is why the contained test config above uses the worktree path. Note this is
project-scoped, not the user-level `~/.codex/hooks.json` the spike intends to wire.

### Next steps to fully close the spike

1. Run outside the sandbox (or with `--allow` for `~/.claude`, `~/.codex`,
   and the agent binaries) and install the hook at the user level:
   - `~/.claude/settings.json`
   - `~/.codex/hooks.json`
2. Live test `UserPromptSubmit`: prompt an image path, confirm the fake context
   appears in the agent's context.
3. Live test `PreToolUse Read`: ask the agent to read an image file, confirm the
   fake context appears before/after the tool result.
4. Record pass/fail, then proceed to Phase 2 (real `vp analyze` dispatch + installer
   rewrite).
