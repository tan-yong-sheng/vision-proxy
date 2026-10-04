# Agent integrations

Install `vp` into an agent so it can see images in your prompts.

## Claude Code

Prerequisite: Node 22.6+ must be on PATH for the `node --experimental-strip-types` hook command to run.

Writes a `vision-proxy_read.ts` hook script to `~/.claude/hooks/` and registers three hook groups across two hook events in `~/.claude/settings.json`, all running it as a plain `node --experimental-strip-types ~/.claude/hooks/vision-proxy_read.ts` command with only standard hook keys (no vision-proxy metadata in the config):

- `UserPromptSubmit` - appends a static reminder to inspect each image mentioned in the prompt with the `Read` tool. Pasted/attached images (rendered as `[Image #N]` refs) are resolved via Claude Code's `image-cache/<session>/<N>.<ext>` so each gets a reminder line too. Never shells out, so prompt submission is never blocked on a vision call.
- `PreToolUse Read` - the single analysis point: describes an image read via the `Read` tool (`file_path`). Fail-closed: an image read whose analysis fails is denied with the cause named, so a text-only model never falls through to the native `Read` (which would only answer with a provider 400).
- `PreToolUse Bash` - rewrites a model-invoked `vp analyze` command to append `--context-file <path>`: the hook writes the recent conversation (from the handed transcript) to a `0600` tempfile so the model's own command executes with context. Fail-open: any failure leaves the command unchanged.

```bash
vp integration install claude
vp integration status
```

The agent id was renamed from `claude-code` to `claude` (matching the
`claude` CLI binary, like `codex` and `pi` match theirs). The old
`claude-code` id still works everywhere as a deprecated alias and resolves
to the same integration; installed files are unchanged, so no reinstall is
needed.

Uninstall (one agent, or every integration at once):

```bash
vp integration uninstall claude
vp integration uninstall --all
```

`--all` removes every supported integration (`pi`, `claude`, `codex`)
plus orphaned v1 opencode plugin files, one agent per output line, without
stopping at the first failure. An explicit `<agent>` cannot be combined
with `--all`.

## Codex

Prerequisite: Node 22.6+ must be on PATH for the `node --experimental-strip-types` hook command to run.

Writes the same `vision-proxy_read.ts` hook script to `~/.codex/hooks/` and registers three hook groups across two hook events in `~/.codex/hooks.json` as plain `node --experimental-strip-types ~/.codex/hooks/vision-proxy_read.ts` commands with only standard hook keys:

- `UserPromptSubmit` - appends a static reminder to inspect each image mentioned in the prompt with the `view_image` tool. Never shells out, so prompt submission is never blocked on a vision call.
- `PreToolUse view_image` - analyzes Codex's native image-view request (`path`) and denies it before Codex reads image bytes, returning the vision description as hook context. Fail-closed like Claude Code: a failed analysis is denied with the cause named, never passed through to native `view_image`.
- `PreToolUse Bash` - rewrites a model-invoked `vp analyze` command to append `--context-file <path>` (same tempfile handoff as Claude Code).

Codex has no `Read` tool (its image path is `view_image`), so no `Read` matcher is registered for this host. Claude Code keeps its existing `Read` registration.

Legacy installs that appended a `[[UserPromptSubmit]]` block to `~/.codex/config.toml` are migrated automatically: `vp integration install codex` and `vp integration uninstall codex` both remove that stale block.

```bash
vp integration install codex
vp integration status
```

Uninstall:

```bash
vp integration uninstall codex
# or remove every integration at once:
vp integration uninstall --all
```

## Pi

Installs the `vision-proxy_read.ts` extension into `~/.pi/agent/extensions/`. The extension hooks into Pi's lifecycle events (no tool is registered, keeping system tokens low):

- `input` — no-op. Returns immediately so the user's prompt is accepted the instant they press Enter.
- `context` — appends a static reminder to read each image path referenced in the user text with the `read` tool. It never shells out to `vp analyze`, so sends stay fast. Image attachments are left untouched so the model sees them natively.
- `tool_result` — the single analysis point. Intercepts `read` tool results on image files and replaces the tool result content with the fenced UNTRUSTED description so no image bytes reach the model. Fail-closed: a failed analysis returns a message naming the cause instead of the raw image.
- `tool_call` — rewrites a model-invoked `vp analyze` bash command before it executes: appends `--context-file <path>` (context from the session branch, written to a `0600` tempfile) by mutating the tool input in place. The model's own command executes; every failure leaves the input unmutated.

The reminder is appended in the `context` event for every submission Pi assembles for the model, including ones queued via the `streamingBehavior` option while a previous turn is streaming and ones dispatched through `session.steer()` / `session.followUp()` (which route through the same `session.prompt()` path). Repeated events strip the prior reminder before re-appending, so reminder text never duplicates.

If `vp analyze` fails outside an image read (e.g. the `tool_call` context rewrite) or `VP_MODE=off`, the extension fails open and Pi proceeds unchanged. Failed image reads fail closed per the `tool_result` bullet above.

```bash
vp integration install pi
vp integration status
```

Uninstall:

```bash
vp integration uninstall pi
# or remove every integration at once:
vp integration uninstall --all
```

Restart Pi after installing.

Configuration options (via environment variables):
- `VP_MODE` - Controls whether the Pi extension is active (`always` | `off`, default: `always`)
- `VP_MAX_OUTPUT_TOKENS` - Max output tokens for `vp analyze` (default: 2000)
- `VP_HOOK_TIMEOUT_MS` - Timeout for vp analyze in milliseconds (default: 30000)
- `VP_BIN` - Path to vp binary (default: "vp"; a `.js` entry point is run with the current Node executable)

## opencode (paused while v2 stabilizes)

opencode support is currently paused. The v1 plugin this repo shipped
(`chat.message` + `tool.execute.before` hooks) does not load under
opencode v2 — V1-style plugin exports fail with `SchemaError`, and the
v2 API (`Plugin.define` + `setup(ctx)` with domain-registered hooks) is
a rewrite, not a rename. Developing against both APIs while v2 is still
moving is churn, so `vp integration install opencode` now reports the
pause instead of installing.

What still works: the CLI reader can consume a fresh pending context file
when `OPENCODE` is set, but opencode v2 does not currently provide an
integration that writes that file. Revisit a
native v2 plugin once the API stabilizes.

## Local integration development

When running the built CLI from this checkout, use `--dev` so generated artifacts call this same CLI instead of requiring a globally installed `vp` binary:

```bash
npm run build
node dist/cli.js integration install pi --dev
node dist/cli.js integration install claude --dev
node dist/cli.js integration install codex --dev
```

`--dev` embeds the current CLI entry-point path in the generated artifact. `VP_BIN` still takes precedence at runtime. Re-run the command if the checkout moves. Normal installations should continue using `vp integration install <agent>`; they default to `vp` on `PATH` and are unaffected by development installs.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agent CLI not found | Install Claude Code, Codex, or Pi first (opencode paused while its v2 API stabilizes). |
| Hook not firing | Claude Code / Codex: confirm the config file contains the `UserPromptSubmit` and `PreToolUse` blocks (including the `Bash` matcher for model-invoked `vp analyze`). Pi: check Pi logs for `[vision-proxy]` messages; ensure `vp` is on PATH or set `VP_BIN`. |
| Hook script not found (`node --experimental-strip-types ...vision-proxy_read.ts` fails) | Re-run `vp integration install <agent>` to regenerate the script, ensure Node 22.6+ is on PATH, and ensure `vp` is on PATH (or set `VP_BIN`). |
| Stale Codex marker outside a block | Run `vp integration uninstall codex` and reinstall. |
| Pi extension not loading | Restart Pi after installing. |
| Pi images not described | Check Pi logs for `[vision-proxy]` messages; ensure `vp` is on PATH or set `VP_BIN`. |
