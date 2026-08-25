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

Installs the `vision-proxy.ts` extension into `~/.pi/agent/extensions/`.

```bash
vp integration install pi
vp integration status pi
```

Uninstall:

```bash
vp integration uninstall pi
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agent CLI not found | Install Claude Code, Codex, Pi, or opencode first. |
| Hook not firing | Confirm the config file contains the `UserPromptSubmit` and `PreToolUse` blocks. |
| `vp hook` not found | Re-run `vp integration install <agent>` so the absolute binary path is written into the config, or ensure `vp` is on PATH. |
| Stale Codex marker outside a block | Run `vp integration uninstall codex` and reinstall. |
| Pi extension not loading | Restart Pi after installing. |
| opencode plugin not loading | Run `opencode plugin list` to verify installation; restart opencode after installing. |

## opencode (v1)

Installs the `vision-proxy.ts` plugin into `~/.config/opencode/plugins/`.

The plugin registers hooks for **strict parity with claude-code/codex**:
- `chat.message` hook - like `UserPromptSubmit`: extracts image paths from user prompt, runs `vp analyze`, injects description as additional context
- `tool.execute.before` hook (Read) - like `PreToolUse Read`: intercepts `Read` tool calls on image files, runs `vp analyze`, injects description as additional context, denies the native Read

No new `analyze_image` tool is registered - the agent uses its native Read tool which the hook intercepts and replaces with vision-proxy description.

```bash
vp integration install opencode
vp integration status opencode
```

Uninstall:

```bash
vp integration uninstall opencode
```

The plugin requires:
- opencode v1 CLI installed
- `vp` binary on PATH (or set `VP_BIN` environment variable)

Configuration options (via environment variables):
- `VP_MAX_OUTPUT_TOKENS` - Max output tokens for `vp analyze` (default: 2000)
- `VP_HOOK_TIMEOUT_MS` - Timeout for vp analyze in milliseconds (default: 30000)
- `VP_BIN` - Path to vp binary (default: "vp")
