# Claude Code integration

Install `vp` as a Claude Code `UserPromptSubmit` hook so Claude Code can see images from your prompts.

## What it does

- Writes a small `claude-code-user-prompt-submit.mjs` shim next to the `vp` binary.
- Adds a `UserPromptSubmit` entry to `~/.claude/settings.json`.
- The shim runs `vp analyze --hook` on images referenced in your prompt and appends the description as additional context.

## Install

```bash
vp integration install claude-code
```

## Verify

```bash
vp integration status claude-code
```

## Uninstall

```bash
vp integration uninstall claude-code
```

## What gets added to `~/.claude/settings.json`

```json
{
  "UserPromptSubmit": [
    {
      "type": "command",
      "command": "/path/to/claude-code-user-prompt-submit.mjs"
    }
  ]
}
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `claude-code` not found | Install the Claude Code CLI first. |
| Hook not firing | Confirm `~/.claude/settings.json` contains the `UserPromptSubmit` block. |
| `vp analyze --hook` not found | Run `pnpm run build` and ensure `dist/cli.js` exists. |
