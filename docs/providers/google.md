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

## Run

```bash
vp analyze screenshot.png
```

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
