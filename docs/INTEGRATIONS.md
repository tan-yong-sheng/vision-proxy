# Agent integrations

Install `vp` into an agent so it can see images in your prompts.

## Claude Code

Registers two hooks in `~/.claude/settings.json`, both invoking the absolute `vp hook` path:

- `UserPromptSubmit` - describes images mentioned in the prompt.
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
| Agent CLI not found | Install Claude Code, Codex, or Pi first. |
| Hook not firing | Confirm the config file contains the `UserPromptSubmit` and `PreToolUse` blocks. |
| `vp hook` not found | Re-run `vp integration install <agent>` so the absolute binary path is written into the config, or ensure `vp` is on PATH. |
| Stale Codex marker outside a block | Run `vp integration uninstall codex` and reinstall. |
| Pi extension not loading | Restart Pi after installing. |
