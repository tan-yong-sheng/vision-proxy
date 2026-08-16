# Agent integrations

Install `vp` into an agent so it can see images in your prompts.

## Claude Code

Installs a `UserPromptSubmit` shim into `~/.claude/settings.json`.

```bash
vp integration install claude-code
vp integration status claude-code
```

Uninstall:

```bash
vp integration uninstall claude-code
```

## Codex

Installs a `UserPromptSubmit` shim into `~/.codex/config.toml`.

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
| Hook not firing | Confirm the config file contains the `UserPromptSubmit` block. |
| `vp analyze --hook` not found | Run `pnpm run build` and ensure `dist/cli.js` exists. |
| Stale Codex marker outside a block | Run `vp integration uninstall codex` and reinstall. |
| Pi extension not loading | Restart Pi after installing. |
