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

## Run

```bash
vp analyze screenshot.png
```

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
