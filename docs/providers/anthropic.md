# Anthropic setup

Use Anthropic's Claude vision model with `vp`.

## Prerequisites

- An Anthropic API key.
- The key exported as `ANTHROPIC_API_KEY`.

## Set the API key

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Or store it in the OS keyring:

```bash
echo "sk-ant-..." | vp provider store-key anthropic
```

## Configure `vp`

```bash
vp config set provider anthropic
vp config set modelId claude-sonnet-4-5
```

Or write the full config to `~/.vision-proxy/config.json`:

```json
{
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "fallbackModels": ["openai/gpt-4o"]
}
```

## Run

```bash
vp analyze screenshot.png
```

## Fallback models

If `claude-sonnet-4-5` fails, `vp` can try another model:

```bash
vp config set fallbackModels '["openai/gpt-4o","google/gemini-2.5-flash"]'
```

Or in `~/.vision-proxy/config.json`:

```json
{
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "fallbackModels": ["openai/gpt-4o", "google/gemini-2.5-flash"]
}
```

A missing API key on the primary provider is a fatal error; fallbacks only kick in once a model call actually fails.

## Use a custom endpoint

Point `vp` at any Anthropic-compatible endpoint with the `ANTHROPIC_BASE_URL` env var:

```bash
export ANTHROPIC_BASE_URL="http://localhost:8000/v1"
vp analyze screenshot.png
```

Or persist it in config:

```bash
vp config set baseURLs '{"anthropic":"http://localhost:8000/v1"}'
```

Env vars override the config-file `baseURLs` value for a single invocation.
