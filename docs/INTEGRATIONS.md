# Agent integrations

Install `vp` into an agent so it can see images in your prompts.

## Claude Code

Registers two hooks in `~/.claude/settings.json`, both invoking the absolute `vp hook` path:

- `UserPromptSubmit` - describes images mentioned in the prompt, plus pasted/attached images (rendered as `[Image #N]` refs) resolved via Claude Code's `image-cache/<session>/<N>.<ext>`.
- `PreToolUse Read` - describes an image read via the `Read` tool (`file_path`).

```bash
vp integration install claude-code
vp integration status claude-code
```

Uninstall:

```bash
vp integration uninstall claude-code
```

## Codex

Registers the same two hooks in `~/.codex/hooks.json`, both invoking the absolute `vp hook` path:

- `UserPromptSubmit` - describes images mentioned in the prompt.
- `PreToolUse Read` - describes an image read via the `Read` tool (`file_path`).

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

- `input` — extracts images attached to the submission plus image paths referenced in the text, runs `vp analyze`, and strips the image bytes and path mentions from the submission. Attachments whose mime type is outside the supported set (jpg, jpeg, png, gif, webp, bmp, tiff, ico, avif) are forwarded to the model unchanged. For idle prompts the description is stashed for the `before_agent_start` event; for prompts queued via the `streamingBehavior` option the description is embedded in the transformed text, because `before_agent_start` does not fire for queued messages.
- `before_agent_start` — appends the fenced UNTRUSTED description from the analyzed submission to the system prompt.
- `tool_result` — intercepts `read` tool results on image files and replaces the tool result content with the fenced description so no image bytes reach the model.

The `input` event fires for every `session.prompt()` submission, including ones that arrive while the agent is streaming and are queued via the `streamingBehavior` option. It does not fire for messages dispatched through the separate `session.steer()` or `session.followUp()` APIs (for example the RPC `steer` / `follow_up` commands or queued-message retry paths) — those submissions reach the model with their image attachments intact.

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
- `chat.message` hook - like `UserPromptSubmit`: extracts image paths from the user text, decodes attached image parts (data URLs), runs `vp analyze`, removes the analyzed image parts from the message so no bytes reach the model, and appends the fenced description as a synthetic text part.
- `tool.execute.before` hook (`read`) - like `PreToolUse Read`: intercepts `read` tool calls on image files, runs `vp analyze`, and denies the read by throwing an error whose message carries the instruction and description.

No new `analyze_image` tool is registered - the agent uses its native Read tool which the hook intercepts.

Analysis is **unconditional by design**, matching the claude-code/codex hooks: the plugin never inspects the chat model's modality. Installing the plugin is the explicit opt-in to route every image through vision-proxy; multimodal models receive the fenced description instead of raw image bytes. To restore native image input, uninstall the plugin. Injected descriptions carry a stable `[vision-proxy:image]` marker so prior injections are stripped if the hook ever re-fires for the same message.

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

Configuration options (via environment variables):
- `VP_MAX_OUTPUT_TOKENS` - Max output tokens for `vp analyze` (default: 2000)
- `VP_HOOK_TIMEOUT_MS` - Timeout for vp analyze in milliseconds (default: 30000)
- `VP_BIN` - Path to vp binary (default: "vp"; a `.js` entry point is run with the current Node executable)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agent CLI not found | Install Claude Code, Codex, Pi, or opencode first. |
| Hook not firing | Claude Code / Codex: confirm the config file contains the `UserPromptSubmit` and `PreToolUse` blocks. opencode: verify the plugin's `chat.message` and `tool.execute.before` hooks via `opencode plugin list`. |
| `vp hook` not found | Re-run `vp integration install <agent>` so the absolute binary path is written into the config, or ensure `vp` is on PATH. |
| Stale Codex marker outside a block | Run `vp integration uninstall codex` and reinstall. |
| Pi extension not loading | Restart Pi after installing. |
| Pi images not described | Check Pi logs for `[vision-proxy]` messages; ensure `vp` is on PATH or set `VP_BIN`. |
| opencode plugin not loading | Run `opencode plugin list` to verify installation; restart opencode after installing. |
