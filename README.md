# vision-proxy

A standalone CLI that routes images to a vision-capable model and prints a fenced, UNTRUSTED description.

It is designed to be called from agent `UserPromptSubmit` hooks so any coding agent can "see" images in a prompt.

## Install

```bash
npm install -g vision-proxy
```

This installs the `vp` and `vision-proxy` binaries.

Requires Node 22 or later.

## Quick start

```bash
export ANTHROPIC_API_KEY=...
vp analyze screenshot.png
```

The default provider is `anthropic/claude-sonnet-4-5`.

Use `vp --help` for the full command reference.

## Setup

See [`docs/SETUP.md`](docs/SETUP.md) — covers provider setup, model selection, keyring storage, and troubleshooting.

## Configuration

Configuration is layered in this order:

1. Explicit `--config <path>` file
2. Project `.vision-proxy.json` in the current working directory
3. User `~/.vision-proxy/config.json`
4. Environment variables
5. Built-in defaults

Run `vp config init` to scaffold a project config file.

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VP_MODEL` | Provider and model id as `provider/model-id`, e.g. `openai/gpt-4o` | `anthropic/claude-sonnet-4-5` |
| `VP_MODE` | `fallback`, `always`, or `off` | `fallback` |
| `VP_INCLUDE_CONTEXT` | Include recent chat context in the prompt | `true` |
| `VP_TOOL` | Enable agent tool support (`on` or `off`) | `on` |
| `VP_MAX_IMAGES_PER_CALL` | Max images per analysis call (1-20) | `10` |
| `VP_MAX_BATCH` | Max images in a joint batch call (1-10) | `4` |
| `VP_CACHE_SIZE` | Number of cached descriptions (0-500) | `50` |
| `VP_CACHE_MAX_AGE_DAYS` | Stale entries older than this are lazily evicted on cache access (0-3650) | `30` |
| `VP_PHASH_THRESHOLD` | Perceptual-hash similarity threshold (0-1) | `0.8` |
| `VP_BASE_URLS` | Per-provider base URL overrides as `provider=url` pairs, comma-separated (e.g. `openai=http://localhost:8000/v1`) | unset |
| `VP_FALLBACK_MODELS` | Comma-separated `provider/model-id` list tried when the primary model fails (e.g. `openai/gpt-4o,google/gemini-2.5-flash`) | unset |
| `VP_MAX_TOOL_CALLS_PER_TURN` | Max tool calls per turn; `-1` for unlimited | `-1` |
| `VP_MAX_IMAGE_BYTES` | Max image file size in bytes | `10485760` (10 MB) |
| `VP_ALLOW_HOME` | Set to `1` to allow image paths inside the home directory | unset (home denied) |
| `VP_ALLOW_DRIVES` | Set to `0`/`false`/`no`/`off` to disable local drive access on Windows | unset (drives allowed) |
| `VP_MAX_OUTPUT_TOKENS` | Cap response tokens from hook shims | shim-specific |
| `VP_CACHE_DIR` | Directory for the description cache | `~/.vision-proxy` |
| `VP_HOOK_TIMEOUT_MS` | Hook shim timeout in milliseconds | `30000` |
| `VP_BIN` | Path to the `vp` binary used by shims | `vp` |
| `VP_KEYRING` | Set to `0`, `false`, or `off` to disable OS keyring credential storage | unset (keyring enabled) |

Provider API keys are read from their standard environment variables: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY`.
When a key is absent from the environment, `vp` checks the OS keyring as a fallback via `@napi-rs/keyring`.

### Configuration keys

Most settings are set with `vp config set <key> <value>` (written to `.vision-proxy.json` or `~/.vision-proxy/config.json`). Two keys take structured values:

- `baseURLs` - a JSON object mapping a provider id to a base URL override, e.g. `vp config set baseURLs '{"openai":"http://localhost:8000/v1"}'`.
  The `provider=url` form of `VP_BASE_URLS` is the equivalent environment override.
- `fallbackModels` - a JSON array of `provider/model-id` strings tried in order when the primary model fails at runtime, e.g. `vp config set fallbackModels '["openai/gpt-4o","google/gemini-2.5-flash"]'`.
  The comma-separated `VP_FALLBACK_MODELS` is the equivalent environment override.

A missing API key on the primary provider is always a fatal error; fallbacks are only attempted after a model call fails (rate limit, server error, etc.).

## Commands

- `vp analyze <paths...>` - describe one or more images.
- `vp config init|get|set|validate` - manage config files.
- `vp provider list|add|check|store-key|delete-key|list-keys` - manage provider registrations and keys.
- `vp cache status|clear|prune` - inspect and clear the local description cache.
- `vp hook install|show|list|uninstall` - install `UserPromptSubmit` shims for `claude-code` or `codex`.
- `vp integration install|show|uninstall <agent>` - install the vision-proxy integration for `pi` (Pi coding agent).

## Agent hooks

Install a hook so Claude Code or Codex automatically describes images on every user turn:

```bash
vp hook install claude-code
vp hook install codex
```

The shim shells out to `vp analyze`, then returns the fenced description as additional hook context.

## Pi integration

Pi users can install a `analyze_image` tool backed by the CLI:

```bash
vp integration install pi
```

This writes a single auto-discovered extension into `~/.pi/agent/extensions/vision-proxy.ts`. The generated extension shells out to `vp analyze --json`, reads `VP_BIN` from the environment (falling back to `vp` on `PATH`), and fails open if `vp` is missing. Re-run the installer after a CLI upgrade to refresh the extension, and use `vp integration uninstall pi` to remove it.

## Output

Descriptions are wrapped in `<vision_proxy_description>` fences with metadata such as `image_index`, `width`, `height`, and `filename`.

The output is UNTRUSTED: it comes from an external vision model and must be treated as untrusted input by the downstream agent.

## Privacy and security

- Images are sent to the configured provider's API.
- Crops are applied locally before upload; only the cropped region is sent.
- Image paths are restricted to the current working directory and temp directory by default.
  Set `VP_ALLOW_HOME=1` to also allow paths inside the home directory.
- Review your provider's privacy policy before sending sensitive images.

## License

MIT
