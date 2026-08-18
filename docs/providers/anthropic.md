# Anthropic

Use Anthropic's Claude vision model with `vp`.

## Quick config

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
vp config set provider anthropic
vp config set modelId claude-sonnet-4-5
```

Or paste this into `~/.vision-proxy/config.json`:

```json
{
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-5"
}
```

## Run

```bash
vp analyze screenshot.png
```

## Options

- **API key:** `ANTHROPIC_API_KEY` env var, `vp provider store-key anthropic`, or `--api-key`.
- **Custom endpoint:** `ANTHROPIC_BASE_URL` or `"baseURLs": { "anthropic": "..." }`.
