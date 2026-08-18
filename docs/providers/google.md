# Google

Use Google's Gemini vision model with `vp`.

## Quick config

```bash
export GOOGLE_API_KEY="..."
vp config set provider google
vp config set modelId gemini-2.5-pro
```

Or paste this into `~/.vision-proxy/config.json`:

```json
{
  "provider": "google",
  "modelId": "gemini-2.5-pro"
}
```

## Run

```bash
vp analyze screenshot.png
```

## Options

- **API key:** `GOOGLE_API_KEY` env var, `vp provider store-key google`, or `--api-key`.
- **Custom endpoint:** `GOOGLE_BASE_URL` or `"baseUrl": "..."` in config.
