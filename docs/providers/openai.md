# OpenAI

Use OpenAI's GPT-4o vision model with `vp`.

## Quick config

```bash
export OPENAI_API_KEY="sk-..."
vp config set provider openai
vp config set modelId gpt-4o
```

Or paste this into `~/.vision-proxy/config.json`:

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

## Options

- **API key:** `OPENAI_API_KEY` env var, `vp provider store-key openai`, or `--api-key`.
- **Custom endpoint:** `OPENAI_BASE_URL` or `"baseURLs": { "openai": "..." }`.
- **Fallback models:** `VP_FALLBACK_MODELS` or `"fallbackModels": ["google/gemini-2.5-flash", ...]`.
