# Setup Guide

How to get a vision-capable model working with `vp`.

## Where to start

- **New user?** → [QUICKSTART.md](./QUICKSTART.md)
- **Pick a provider** → links below
- **Full config schema** → [CONFIG.md](./CONFIG.md)
- **Agent integrations** → [INTEGRATIONS.md](./INTEGRATIONS.md)
- **Environment variables** → [CONFIG.md#environment-variables](./CONFIG.md#environment-variables)

## Providers

- [OpenAI](./providers/openai.md)
- [Anthropic](./providers/anthropic.md)
- [Google](./providers/google.md)

## Agent integrations

Install `vp` into your agent so it can see images in prompts:

- [INTEGRATIONS.md](./INTEGRATIONS.md) — Claude Code, Codex, Pi

## Keyring storage

Store API keys in the OS keyring instead of env vars:

```bash
echo "sk-..." | vp provider store-key openai
vp provider list-keys
vp provider delete-key openai
```

## Config precedence

1. `--config <path>` flag
2. `.vision-proxy.json` in cwd
3. `~/.vision-proxy/config.json`
4. Environment variables (`VP_*` and provider env vars)
5. Built-in defaults

See [CONFIG.md](./CONFIG.md) for the full schema and copy-paste JSON examples.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `no API key for provider "openai"` | Set `OPENAI_API_KEY` or use `--api-key` |
| `path is not a local absolute path` | Use an absolute path on a local drive (not a network share), or an `http://` / `https://` URL |
| `file extension does not match actual image content` | Ensure the file extension matches the content, or set `VP_STRICT_MIME=0` to allow lenient mode |
| `download timeout` | Increase `VP_DOWNLOAD_TIMEOUT` or check network connectivity |
| `model is currently experiencing high demand` | Retry the same model later; transient retries (429, 5xx) are automatic |

