# OpenAI setup

Use OpenAI's GPT-4o vision model with `vp`.

## Prerequisites

- An OpenAI API key.
- The key exported as `OPENAI_API_KEY`.

## Set the API key

```bash
export OPENAI_API_KEY="sk-..."
```

Or store it in the OS keyring:

```bash
echo "sk-..." | vp provider store-key openai
```

## Configure `vp`

```bash
vp config set provider openai
vp config set modelId gpt-4o
```

Or write the full config to `~/.vision-proxy/config.json`:

```json
{
  "provider": "openai",
  "modelId": "gpt-4o",
  "fallbackModels": ["google/gemini-2.5-flash"]
}
```

## Run

```bash
vp analyze screenshot.png
```

## Fallback models

If `gpt-4o` fails, `vp` can try another model:

```bash
vp config set fallbackModels '["google/gemini-2.5-flash","anthropic/claude-sonnet-4-5"]'
```

Or in `~/.vision-proxy/config.json`:

```json
{
  "provider": "openai",
  "modelId": "gpt-4o",
  "fallbackModels": ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4-5"]
}
```

A missing API key on the primary provider is a fatal error; fallbacks only kick in once a model call actually fails.

## Use a custom endpoint

Point `vp` at any OpenAI-compatible endpoint with the `OPENAI_BASE_URL` env var:

```bash
export OPENAI_BASE_URL="http://localhost:8000/v1"
vp analyze screenshot.png
```

Or persist it in config:

```bash
vp config set baseURLs '{"openai":"http://localhost:8000/v1"}'
```

Env vars override the config-file `baseURLs` value for a single invocation.
