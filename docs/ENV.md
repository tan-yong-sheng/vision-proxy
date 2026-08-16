# Environment variables

`vp` reads configuration from environment variables with the following precedence:

1. CLI flags (`--api-key`, `--config`, etc.)
2. Config files (`--config`, `.vision-proxy.json`, `~/.vision-proxy/config.json`)
3. Environment variables
4. Built-in defaults

## Provider API keys

| Variable | Provider | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | OpenAI | API key for OpenAI models. |
| `ANTHROPIC_API_KEY` | Anthropic | API key for Anthropic models. |
| `GOOGLE_API_KEY` | Google | API key for Gemini models. |

## Provider base URLs

| Variable | Provider | Purpose |
|----------|----------|---------|
| `OPENAI_BASE_URL` | OpenAI | Override the OpenAI API endpoint. |
| `ANTHROPIC_BASE_URL` | Anthropic | Override the Anthropic API endpoint. |
| `GOOGLE_BASE_URL` | Google | Override the Google API endpoint. |

## `VP_*` variables

| Variable | Maps to config key | Example |
|----------|--------------------|---------|
| `VP_PROVIDER` | `provider` | `VP_PROVIDER=openai` |
| `VP_MODEL` | `modelId` | `VP_MODEL=gpt-4o` |
| `VP_MODE` | `mode` | `VP_MODE=always` |
| `VP_INCLUDE_CONTEXT` | `includeContext` | `VP_INCLUDE_CONTEXT=true` |
| `VP_TOOL` | `tool` | `VP_TOOL=off` |
| `VP_MAX_IMAGES_PER_CALL` | `maxImagesPerCall` | `VP_MAX_IMAGES_PER_CALL=2` |
| `VP_MAX_BATCH` | `maxBatch` | `VP_MAX_BATCH=2` |
| `VP_CACHE_SIZE` | `cacheSize` | `VP_CACHE_SIZE=50` |
| `VP_CACHE_MAX_AGE_DAYS` | `cacheMaxAgeDays` | `VP_CACHE_MAX_AGE_DAYS=7` |
| `VP_PHASH_SIMILARITY_THRESHOLD` | `pHashSimilarityThreshold` | `VP_PHASH_SIMILARITY_THRESHOLD=0.95` |
| `VP_FALLBACK_MODELS` | `fallbackModels` | `VP_FALLBACK_MODELS="openai/gpt-4o,google/gemini-2.5-flash"` |
| `VP_BASE_URLS` | `baseURLs` | `VP_BASE_URLS='openai=http://localhost:8000/v1'` |

## Example

```bash
export OPENAI_API_KEY="sk-..."
VP_PROVIDER=openai VP_MODEL=gpt-4o vp analyze screenshot.png
```
