# Google setup

Use Google's Gemini vision model with `vp`.

## Prerequisites

- A Google API key (Gemini API).
- The key exported as `GOOGLE_API_KEY`.

## Set the API key

```bash
export GOOGLE_API_KEY="..."
```

Or store it in the OS keyring:

```bash
echo "..." | vp provider store-key google
```

## Configure `vp`

```bash
vp config set provider google
vp config set modelId gemini-2.5-pro
```

Or write the full config to `~/.vision-proxy/config.json`:

```json
{
  "provider": "google",
  "modelId": "gemini-2.5-pro",
  "fallbackModels": ["openai/gpt-4o"]
}
```

## Run

```bash
vp analyze screenshot.png
```

## Fallback models

If `gemini-2.5-pro` fails, `vp` can try another model:

```bash
vp config set fallbackModels '["openai/gpt-4o","anthropic/claude-sonnet-4-5"]'
```

Or in `~/.vision-proxy/config.json`:

```json
{
  "provider": "google",
  "modelId": "gemini-2.5-pro",
  "fallbackModels": ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]
}
```

A missing API key on the primary provider is a fatal error; fallbacks only kick in once a model call actually fails.

## Use a custom endpoint

Point `vp` at a Vertex AI or other Gemini-compatible endpoint with the `GOOGLE_BASE_URL` env var:

```bash
export GOOGLE_BASE_URL="https://..."
vp analyze screenshot.png
```

Or persist it in config:

```bash
vp config set baseURLs '{"google":"https://..."}'
```

Env vars override the config-file `baseURLs` value for a single invocation.
