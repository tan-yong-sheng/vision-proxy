# Setup Guide

How to get a vision-capable model working with `vp`.

For the fastest path from install to first result, see [QUICKSTART.md](./QUICKSTART.md).

## Pick a provider

`vp` supports API-key-backed providers and the Agent Client Protocol (ACP).

- [OpenAI](./providers/openai.md)
- [Anthropic](./providers/anthropic.md)
- [Google](./providers/google.md)
- [ACP](./providers/acp.md) (Claude Code, Gemini CLI, Codex CLI)

## Set defaults

After following one of the provider guides, set the default provider and model:

```bash
vp config set provider openai
vp config set modelId gpt-4o
```

Now `vp analyze` without `--provider` / `--model` uses those defaults.

Check the resolved config:

```bash
vp config get
```

## Run

```bash
vp analyze screenshot.png
```

## Agent integrations

Install `vp` into your agent so it can see images in prompts:

- [Claude Code](./integrations/claude-code.md)
- [Codex](./integrations/codex.md)
- [Pi](./integrations/pi.md)

## Shared options

### Fallback models

If the primary model is rate-limited or unavailable, configure fallback models that `vp` tries in order after a call fails:

```bash
vp config set fallbackModels '["openai/gpt-4o","google/gemini-2.5-flash"]'
```

Or via env var (comma-separated):

```bash
VP_FALLBACK_MODELS="openai/gpt-4o,google/gemini-2.5-flash" vp analyze screenshot.png
```

A missing API key on the primary provider is a fatal error; fallbacks only kick in once a model call actually fails.

### Keyring storage

API keys can be stored in the OS keyring instead of env vars:

```bash
echo "sk-..." | vp provider store-key openai
```

List stored keys:

```bash
vp provider list-keys
```

Delete a stored key:

```bash
vp provider delete-key openai
```

### Config reference

- [Full config schema and JSON examples](./CONFIG.md)
- [Environment variable reference](./ENV.md)

### Config precedence

1. `--config <path>` flag (highest)
2. `.vision-proxy.json` in cwd
3. `~/.vision-proxy/config.json` (user default)
4. Environment variables (`VP_*` and provider env vars)
5. Built-in defaults

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `no API key for provider "openai"` | Set `OPENAI_API_KEY` or use `--api-key` |
| `path outside allowed directories` | Use an absolute path inside tmp, cwd, or the home directory |
| `model is currently experiencing high demand` | Try a different model or wait |
| `ACP provider requires "acpCommand"` | Set `acpCommand` in config (see [ACP guide](./providers/acp.md)) |
