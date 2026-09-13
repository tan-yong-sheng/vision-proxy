# Agent integrations

Install `vp` into an agent so it can see images in your prompts.

## Claude Code

Prerequisite: `tsx` must be installed for the `npx tsx` hook command to run (`npm install -g tsx`).

Writes a `vision-proxy.ts` hook script to `~/.claude/hooks/` and registers two hooks in `~/.claude/settings.json`, both running it as a plain `npx tsx ~/.claude/hooks/vision-proxy.ts` command with only standard hook keys (no vision-proxy metadata in the config):

- `UserPromptSubmit` - appends a static reminder to inspect each image mentioned in the prompt with the `Read` tool. Pasted/attached images (rendered as `[Image #N]` refs) are resolved via Claude Code's `image-cache/<session>/<N>.<ext>` so each gets a reminder line too. Never shells out, so prompt submission is never blocked on a vision call.
- `PreToolUse Read` - the single analysis point: describes an image read via the `Read` tool (`file_path`).

```bash
vp integration install claude-code
vp integration status claude-code
```

Uninstall:

```bash
vp integration uninstall claude-code
```

## Codex

Prerequisite: `tsx` must be installed for the `npx tsx` hook command to run (`npm install -g tsx`).

Writes the same `vision-proxy.ts` hook script to `~/.codex/hooks/` and registers three hooks in `~/.codex/hooks.json` as plain `npx tsx ~/.codex/hooks/vision-proxy.ts` commands with only standard hook keys:

- `UserPromptSubmit` - appends a static reminder to inspect each image mentioned in the prompt with the `Read` tool. Never shells out, so prompt submission is never blocked on a vision call.
- `PreToolUse Read` - analyzes image reads requested through the `Read` tool (`file_path`).
- `PreToolUse view_image` - analyzes Codex's native image-view request (`path`) and denies it before Codex reads image bytes, returning the vision description as hook context.

The `Read` matcher remains as a fallback for direct file reads. The `view_image` matcher is Codex-specific; Claude Code keeps its existing `Read` registration.

Legacy installs that appended a `[[UserPromptSubmit]]` block to `~/.codex/config.toml` are migrated automatically: `vp integration install codex` and `vp integration uninstall codex` both remove that stale block.

```bash
vp integration install codex
vp integration status codex
```

Uninstall:

```bash
vp integration uninstall codex
```

## Pi

Installs the `vision-proxy.ts` extension into `~/.pi/agent/extensions/`. The extension hooks into Pi's lifecycle events (no tool is registered, keeping system tokens low):

- `input` — no-op. Returns immediately so the user's prompt is accepted the instant they press Enter.
- `context` — appends a static reminder to read each image path referenced in the user text with the `read` tool. It never shells out to `vp analyze`, so sends stay fast. Image attachments are left untouched so the model sees them natively.
- `tool_result` — the single analysis point. Intercepts `read` tool results on image files and replaces the tool result content with the fenced UNTRUSTED description so no image bytes reach the model.

The reminder is appended in the `context` event for every submission Pi assembles for the model, including ones queued via the `streamingBehavior` option while a previous turn is streaming and ones dispatched through `session.steer()` / `session.followUp()` (which route through the same `session.prompt()` path). Repeated events strip the prior reminder before re-appending, so reminder text never duplicates.

If `vp analyze` fails or `VP_MODE=off`, the extension fails open and Pi proceeds unchanged.

```bash
vp integration install pi
vp integration status pi
```

Uninstall:

```bash
vp integration uninstall pi
```

Restart Pi after installing.

Configuration options (via environment variables):
- `VP_MODE` - Controls whether the Pi extension is active (`always` | `off`, default: `always`)
- `VP_MAX_OUTPUT_TOKENS` - Max output tokens for `vp analyze` (default: 2000)
- `VP_HOOK_TIMEOUT_MS` - Timeout for vp analyze in milliseconds (default: 30000)
- `VP_BIN` - Path to vp binary (default: "vp"; a `.js` entry point is run with the current Node executable)

## opencode (v1)

Installs the `vision-proxy.ts` plugin into `~/.config/opencode/plugins/`.

The plugin registers hooks for **parity with claude-code/codex**:
- `chat.message` hook - like `UserPromptSubmit`: extracts image paths from the user text and appends a static reminder to inspect each one with the `read` tool. It never shells out, so message handling stays fast. Attached image parts are left untouched so the model sees them natively.
- `tool.execute.before` hook (`read`) - like `PreToolUse Read`, the single analysis point: intercepts `read` tool calls on image files, runs `vp analyze`, and denies the read by throwing an error whose message carries the instruction and description.

No new `analyze_image` tool is registered - the agent uses its native Read tool which the hook intercepts.

Image-read routing is **unconditional by design**, matching the claude-code/codex hooks: the plugin never inspects the chat model's modality. Installing the plugin is the explicit opt-in to route every image read through vision-proxy; multimodal models receive the fenced description instead of raw image bytes. To restore native image input, uninstall the plugin. Injected reminders carry a stable `[vision-proxy:read-reminder]` marker so prior injections are stripped if the hook ever re-fires for the same message.

If `vp analyze` fails, the plugin fails open: the original message parts and tool calls proceed unchanged.

```bash
vp integration install opencode
vp integration status
```

Uninstall:

```bash
vp integration uninstall opencode
```

The plugin requires:
- opencode v1 CLI installed
- An opencode build that loads TypeScript plugins from `~/.config/opencode/plugins/` (this plugin is plain TypeScript with no build step; on a `.js`-only build the file is written but silently ignored)
- `vp` binary on PATH (or set `VP_BIN` environment variable)

When installed with `--dev`, the generated plugin points at this checkout's `dist/cli.js`. Because OpenCode runs plugins under Bun, vision-proxy launches that JavaScript entry point with `node` rather than OpenCode's own executable. Restart OpenCode after reinstalling so the plugin and launcher behavior are reloaded.

Configuration options (via environment variables):
- `VP_MAX_OUTPUT_TOKENS` - Max output tokens for `vp analyze` (default: 2000)
- `VP_HOOK_TIMEOUT_MS` - Timeout for vp analyze in milliseconds (default: 30000)
- `VP_BIN` - Path to vp binary (default: "vp"; a `.js` entry point is run with the current Node executable)

## Local integration development

When running the built CLI from this checkout, use `--dev` so generated artifacts call this same CLI instead of requiring a globally installed `vp` binary:

```bash
npm run build
node dist/cli.js integration install pi --dev
node dist/cli.js integration install claude-code --dev
node dist/cli.js integration install codex --dev
node dist/cli.js integration install opencode --dev
```

`--dev` embeds the current CLI entry-point path in the generated artifact. `VP_BIN` still takes precedence at runtime. Re-run the command if the checkout moves. Normal installations should continue using `vp integration install <agent>`; they default to `vp` on `PATH` and are unaffected by development installs.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agent CLI not found | Install Claude Code, Codex, Pi, or opencode first. |
| Hook not firing | Claude Code / Codex: confirm the config file contains the `UserPromptSubmit` and `PreToolUse` blocks. opencode: verify the plugin's `chat.message` and `tool.execute.before` hooks via `opencode plugin list`. |
| Hook script not found (`npx tsx ...vision-proxy.ts` fails) | Re-run `vp integration install <agent>` to regenerate the script, ensure `npx`/`tsx` is available, and ensure `vp` is on PATH (or set `VP_BIN`). |
| Stale Codex marker outside a block | Run `vp integration uninstall codex` and reinstall. |
| Pi extension not loading | Restart Pi after installing. |
| Pi images not described | Check Pi logs for `[vision-proxy]` messages; ensure `vp` is on PATH or set `VP_BIN`. |
| opencode plugin not loading | Run `opencode plugin list` to verify installation; restart opencode after installing. |
