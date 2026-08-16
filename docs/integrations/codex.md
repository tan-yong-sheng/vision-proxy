# Codex integration

Install `vp` as a Codex `UserPromptSubmit` hook so Codex can see images from your prompts.

## What it does

- Writes a small `codex-user-prompt-submit.mjs` shim next to the `vp` binary.
- Appends a `[[UserPromptSubmit]]` block to `~/.codex/config.toml`.
- The shim runs `vp analyze --hook` on images referenced in your prompt and appends the description as additional context.

## Install

```bash
vp integration install codex
```

## Verify

```bash
vp integration status codex
```

## Uninstall

```bash
vp integration uninstall codex
```

## What gets added to `~/.codex/config.toml`

```toml
[[UserPromptSubmit]]
command = "/path/to/codex-user-prompt-submit.mjs"
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `codex` not found | Install the Codex CLI first. |
| Hook not firing | Confirm `~/.codex/config.toml` contains a `[[UserPromptSubmit]]` block pointing to the shim. |
| Stale marker outside a block | Run `vp integration uninstall codex` and reinstall. |
