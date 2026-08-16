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
  maxBatch: number;
  cacheSize: number;
  cacheMaxAgeDays: number;
  pHashSimilarityThreshold: number;
  groundingModels: Record<string, { format: string }>;
  baseURLs: Record<string, string>;
  fallbackModels: string[];
  acpCommand?: string;
  acpArgs?: string[];
  acpCwd?: string;
  acpMcpServers?: unknown[];
}
```

## Config keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | `anthropic` | Provider id: `openai`, `anthropic`, `google`, or `acp`. |
| `modelId` | string | `claude-sonnet-4-5` | Model id for the selected provider. Ignored when `provider` is `acp`. |
| `mode` | string | `fallback` | When to route tool hooks: `fallback`, `always`, or `off`. |
| `systemPrompt` | string | built-in | System prompt sent to the model. |
| `includeContext` | boolean | `false` | Whether to include extra context in the prompt. |
| `tool` | string | `on` | Enable/disable the tool-mode proxy: `on` or `off`. |
| `maxImagesPerCall` | number | `4` | Max images per single `vp analyze` call. |
| `maxBatch` | number | `4` | Max images in a batch request. |
| `cacheSize` | number | `100` | Max number of cached descriptions. |
| `cacheMaxAgeDays` | number | `30` | Days before a cache entry is considered stale. |
| `pHashSimilarityThreshold` | number | `0.9` | pHash similarity threshold for cache hits. |
| `groundingModels` | object | `{}` | Per-model grounding format overrides. |
| `baseURLs` | object | `{}` | Per-provider base URL overrides, e.g. `{ "openai": "http://localhost:8000/v1" }`. |
| `fallbackModels` | string[] | `[]` | Ordered list of `provider/model-id` strings to try when the primary model fails. |
| `acpCommand` | string | - | ACP executable, e.g. `gemini` or `claude-code-acp`. |
| `acpArgs` | string[] | - | Arguments passed to `acpCommand`. |
| `acpCwd` | string | - | Working directory for the ACP subprocess. |
| `acpMcpServers` | array | - | MCP server configurations for ACP. |

## Example configs

### OpenAI

```json
{
  "provider": "openai",
  "modelId": "gpt-4o",
  "baseURLs": {
    "openai": "https://api.openai.com/v1"
  },
  "fallbackModels": [
    "google/gemini-2.5-flash"
  ]
}
```

### Anthropic

```json
{
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "fallbackModels": [
    "openai/gpt-4o"
  ]
}
```

### Google

```json
{
  "provider": "google",
  "modelId": "gemini-2.5-pro",
  "fallbackModels": [
    "openai/gpt-4o"
  ]
}
```

### ACP

```json
{
  "provider": "acp",
  "acpCommand": "gemini",
  "acpArgs": ["--experimental-acp"]
}
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
