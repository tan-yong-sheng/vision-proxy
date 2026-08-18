# Config reference

`vp` reads configuration from files, environment variables, and CLI flags.
This page describes every config key and shows copy-paste JSON examples.

## Config file locations (precedence)

1. `--config <path>` flag (highest)
2. `.vision-proxy.json` in the current working directory
3. `~/.vision-proxy/config.json` (user default)
4. Environment variables (`VP_*` and provider env vars)
5. Built-in defaults

## Full schema

```typescript
interface VisionConfig {
  mode: "fallback" | "always" | "off";
  provider: string;
  modelId: string;
  systemPrompt: string;
  includeContext: boolean;
  tool: "on" | "off";
  maxImagesPerCall: number;
  /** @deprecated Use `maxImagesPerCall`. One-release alias. */
  maxBatch: number;
  cacheSize: number;
  cacheMaxAgeDays: number;
  pHashSimilarityThreshold: number;
  groundingModels: Record<string, { format: string }>;
  /** Optional base URL override for the current provider. */
  baseUrl: string;
  /** Optional provider API key persisted as plain text in config. */
  apiKey: string;
}
```

## Config keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | `anthropic` | Provider id: `openai`, `anthropic`, or `google`. |
| `modelId` | string | `claude-sonnet-4-5` | Model id for the selected provider. |
| `mode` | string | `fallback` | When to route tool hooks: `fallback`, `always`, or `off`. |
| `systemPrompt` | string | built-in | System prompt sent to the model. |
| `includeContext` | boolean | `false` | Whether to include extra context in the prompt. |
| `tool` | string | `on` | Enable/disable the tool-mode proxy: `on` or `off`. |
| `maxImagesPerCall` | number | `4` | Max images a single `vp analyze` call may receive. This is the canonical, single image limit. |
| `maxBatch` | number | `4` | **Deprecated.** One-release alias for `maxImagesPerCall`. Set `maxImagesPerCall` instead. |
| `cacheSize` | number | `100` | Max number of cached descriptions. |
| `cacheMaxAgeDays` | number | `30` | Days before a cache entry is considered stale. |
| `pHashSimilarityThreshold` | number | `0.9` | pHash similarity threshold for cache hits. |
| `groundingModels` | object | `{}` | Per-model grounding format overrides. |
| `baseUrl` | string | `""` | Base URL override for the current provider, e.g. `http://localhost:8000/v1`. |
| `apiKey` | string | `""` | Provider API key persisted as plain text in config. Prefer `vp provider store-key` for OS keyring storage. |

## Example configs

### OpenAI

```json
{
  "provider": "openai",
  "modelId": "gpt-4o",
  "baseUrl": "https://api.openai.com/v1"
}
```

### Anthropic

```json
{
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-5"
}
```

### Google

```json
{
  "provider": "google",
  "modelId": "gemini-2.5-pro"
}
```

## Environment variables

Most config keys can be overridden by a `VP_*` environment variable. Provider env vars (`OPENAI_API_KEY`, etc.) also work. The `baseUrl` config key is not mirrored by a `VP_*` variable; use the provider-specific `*_BASE_URL` env vars instead.

| Variable | Config key | Example |
|----------|------------|---------|
| `OPENAI_API_KEY` | - | API key for OpenAI. |
| `ANTHROPIC_API_KEY` | - | API key for Anthropic. |
| `GOOGLE_API_KEY` | - | API key for Google Gemini. |
| `OPENAI_BASE_URL` | `baseUrl` | Override OpenAI endpoint. |
| `ANTHROPIC_BASE_URL` | `baseUrl` | Override Anthropic endpoint. |
| `GOOGLE_BASE_URL` | `baseUrl` | Override Google endpoint. |
| `VP_PROVIDER` | `provider` | `VP_PROVIDER=openai` |
| `VP_MODEL` | `modelId` | `VP_MODEL=gpt-4o` |
| `VP_MODE` | `mode` | `VP_MODE=always` |
| `VP_INCLUDE_CONTEXT` | `includeContext` | `VP_INCLUDE_CONTEXT=true` |
| `VP_TOOL` | `tool` | `VP_TOOL=off` |
| `VP_MAX_IMAGES_PER_CALL` | `maxImagesPerCall` | `VP_MAX_IMAGES_PER_CALL=2` |
| `VP_MAX_BATCH` | `maxBatch` | **Deprecated.** Alias for `VP_MAX_IMAGES_PER_CALL`. |
| `VP_CACHE_SIZE` | `cacheSize` | `VP_CACHE_SIZE=50` |
| `VP_CACHE_MAX_AGE_DAYS` | `cacheMaxAgeDays` | `VP_CACHE_MAX_AGE_DAYS=7` |
| `VP_PHASH_SIMILARITY_THRESHOLD` | `pHashSimilarityThreshold` | `VP_PHASH_SIMILARITY_THRESHOLD=0.95` |

### Example

```bash
export OPENAI_API_KEY="sk-..."
VP_PROVIDER=openai VP_MODEL=gpt-4o vp analyze screenshot.png
```

## View and edit

Print the resolved config:

```bash
vp config get
```

Set a single value:

```bash
vp config set provider openai
```

Validate the config:

```bash
vp config validate
```
