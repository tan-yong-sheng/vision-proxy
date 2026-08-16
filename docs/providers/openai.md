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

## Run

```bash
vp analyze screenshot.png
```

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
