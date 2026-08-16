# Setup Guide

How to get a vision-capable model working with `vp`.

## 1. Pick a provider

`vp` supports API-key-backed providers and the Agent Client Protocol (ACP).

### API-key providers

| Provider       | API key env var       | Models                               |
|----------------|----------------------|--------------------------------------|
| OpenAI         | `OPENAI_API_KEY`     | `gpt-4o`                             |
| Anthropic      | `ANTHROPIC_API_KEY`  | `claude-sonnet-4-5`                 |
| Google         | `GOOGLE_API_KEY`     | `gemini-2.5-flash`, `gemini-3.7-flash` |

Set the env var:

```bash
export OPENAI_API_KEY="sk-..."
```

### ACP provider

The ACP (Agent Client Protocol) provider routes image analysis through an ACP-compatible
agent process (Claude Code, Gemini CLI, Codex CLI) instead of an API key.
ACP does not use an environment-variable API key; it spawns a local agent process.

**Setup:**

```bash
vp config set provider acp
vp config set acpCommand gemini
vp config set acpArgs '["--experimental-acp"]'
```

**ACP configuration keys:**

| Key | Description |
|-----|-------------|
| `acpCommand` | The agent executable (e.g. `gemini`, `claude-code-acp`) |
| `acpArgs` | CLI arguments as a JSON array, e.g. `["--experimental-acp"]` |
| `acpCwd` | Working directory for the spawned agent process |
| `acpMcpServers` | MCP server configurations as a JSON array |

> **Note:** When the provider is `acp`, the `model` config key is ignored because the
> agent selects its own model. Also, ACP requires the ability to spawn child
> processes; if your environment blocks subprocess execution, fall back to an
> API-key provider.

**Security note:**

The ACP provider executes a user-supplied binary. Ensure you trust the command
before configuring it.

## 2. Set the default provider and model

```bash
vp config set provider openai
vp config set modelId gpt-4o
```

Now `vp analyze` without `--provider` / `--model` uses those defaults.

Check the resolved config:

```bash
vp config get
```

## 3. Run

```bash
vp analyze screenshot.png
```

### Override the API endpoint

Each provider accepts a `*_BASE_URL` env var to point at any compatible endpoint:

| Provider | Base URL env var | Use case |
|----------|-----------------|---------|
| OpenAI   | `OPENAI_BASE_URL` | local proxy, ollama, vllm |
| Anthropic | `ANTHROPIC_BASE_URL` | self-hosted Anthropic API |
| Google   | `GOOGLE_BASE_URL` | Vertex AI endpoint |

```bash
export OPENAI_BASE_URL="http://localhost:8000/v1"
vp analyze screenshot.png --provider openai --model gpt-4o
```

For Google models:

```bash
GOOGLE_API_KEY="..." vp analyze screenshot.png --provider google --model gemini-3.7-flash
```

### Set a fallback model chain

If your primary model is occasionally rate-limited or unavailable, configure fallback models that `vp` tries in order after a call fails:

```bash
vp config set fallbackModels '["openai/gpt-4o","google/gemini-2.5-flash"]'
```

Or via env var (comma-separated):

```bash
VP_FALLBACK_MODELS="openai/gpt-4o,google/gemini-2.5-flash" vp analyze screenshot.png
```

A missing API key on the primary provider is a fatal error; fallbacks only kick in once a model call actually fails.

### Override the base URL per provider

`baseURLs` maps a provider id to a custom endpoint and persists across calls (the `*_BASE_URL` env var overrides it for a single invocation):

```bash
vp config set baseURLs '{"openai":"http://localhost:8000/v1"}'
```

## 4. (Optional) Keyring storage

API keys can be stored in the OS keyring instead of env vars:

```bash
echo "sk-..." | vp provider store-key openai
```

Then `vp` reads the key from the keyring on every call, so you don't need the env var set.

List stored keys:

```bash
vp provider list-keys
```

Delete a stored key:

```bash
vp provider delete-key openai
```

## 5. Config file locations (precedence)

1. `--config <path>` flag (highest)
2. `.vision-proxy.json` in cwd
3. `~/.vision-proxy/config.json` (user default)
4. Environment variables (`VP_*`)
5. Built-in defaults

## 6. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `no API key for provider "openai"` | Set `OPENAI_API_KEY` or use `--api-key` |
| `path outside allowed directories` | Use an absolute path inside tmp, cwd, or the home directory |
| `model is currently experiencing high demand` | Try a different model or wait |
| `ACP provider requires "acpCommand"` | Set `acpCommand` in config (see step 1) |
