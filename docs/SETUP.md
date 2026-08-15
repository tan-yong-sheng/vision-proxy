# Setup Guide

How to get a vision-capable model working with `vp`.

## 1. Pick a provider

| Provider       | API key env var       | Models                               |
|----------------|----------------------|--------------------------------------|
| OpenAI         | `OPENAI_API_KEY`     | `gpt-4o`                             |
| Anthropic      | `ANTHROPIC_API_KEY`  | `claude-sonnet-4-5`                 |
| Google         | `GOOGLE_API_KEY`     | `gemini-2.5-flash`, `gemini-3.7-flash` |

Set the env var:

```bash
export OPENAI_API_KEY="sk-..."
```

Or register the key with `vp` so the provider is usable:

```bash
vp provider add openai
```

## 2. Set the default provider and model

```bash
vp config set provider openai
vp config set modelId gpt-4o
```

Now `vp analyze` without `--provider` / `--model` uses those defaults.

Check the resolved config:

```bash
vp config get
```

## 3. Run

```bash
vp analyze screenshot.png
```

For Google models:

```bash
GOOGLE_API_KEY="..." vp analyze screenshot.png --provider google --model gemini-3.7-flash
```

## 4. (Optional) Keyring storage

API keys can be stored in the OS keyring instead of env vars:

```bash
echo "sk-..." | vp provider store-key openai
```

Then `vp` reads the key from the keyring on every call, so you don't need the env var set.

List stored keys:

```bash
vp provider list-keys
```

Delete a stored key:

```bash
vp provider delete-key openai
```

## 5. Config file locations (precedence)

1. `--config <path>` flag (highest)
2. `.vision-proxy.json` in cwd
3. `~/.vision-proxy/config.json` (user default)
4. Environment variables (`VP_*`)
5. Built-in defaults

## 6. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `no API key for provider "openai"` | Set `OPENAI_API_KEY` or use `--api-key` |
| `path outside allowed directories` | Pass `VP_ALLOW_HOME=1` or use an absolute path |
| `model is currently experiencing high demand` | Try a different model or wait |
| `unknown provider` | Register it with `vp provider add <name>` |