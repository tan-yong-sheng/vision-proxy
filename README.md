# vision-proxy

A standalone CLI that routes images to a vision-capable model and returns fenced, UNTRUSTED descriptions.
It lets coding agents like Claude Code, Codex, and Pi "see" images in prompts and tool calls.

## Installation

Requires Node 22+ on `PATH`.

### Homebrew (macOS / Linux)

```bash
brew tap tan-yong-sheng/vision-proxy https://github.com/tan-yong-sheng/vision-proxy
brew install tan-yong-sheng/vision-proxy/vision-proxy
```

### curl installer

```bash
curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh
```

To automatically append `~/.local/bin` to your shell profile, pass `--add-to-path`:

```bash
curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh -s -- --add-to-path
```

Restart your shell or source your profile after installation so `vp` is available on your `PATH`.
To install a specific release or pre-release, pass `--version <tag>` (for example `--version v0.1.0-rc.1`).

## Quick start

1. Provide an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

2. Analyze an image:

```bash
vp analyze screenshot.png
```

The default model is `anthropic/claude-sonnet-4-5`.

## Agent Integrations

Install `vp` into your coding agent so it automatically analyzes images from prompts and tool calls:

```bash
# Install integration for your agent
vp integration install claude-code
vp integration install codex
vp integration install pi

# Check installed integrations and version status
vp integration status

# Remove an integration
vp integration uninstall <agent>
```

- **Claude Code & Codex**: Registers `UserPromptSubmit` and `PreToolUse Read` hooks that invoke `vp hook`.
- **Pi**: Installs an auto-discovered `analyze_image` extension into `~/.pi/agent/extensions/`.

See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for troubleshooting and details.

## Commands

| Command | Description |
|---------|-------------|
| `vp analyze <paths...>` | Describe one or more images (`--crop`, `--format`, `--json`, `--model`, `--provider`, `--no-fence`). |
| `vp integration <cmd> [agent]` | Manage agent integrations (`install`, `status`, `list`, `show`, `uninstall`). |
| `vp config <cmd>` | Manage configuration (`init`, `get`, `set`, `validate`). |
| `vp provider <cmd>` | Manage provider auth and keys (`list`, `check`, `store-key`, `delete-key`, `list-keys`). |
| `vp cache <cmd>` | Manage perceptual-hash description cache (`status`, `clear`, `prune`). |

Run `vp --help` or `vp <command> --help` for detailed flag usage.

## Configuration

Configuration is resolved in order: CLI flags, `.vision-proxy.json` (project), `~/.vision-proxy/config.json` (user), environment variables (`VP_*`), and defaults.

```bash
# Scaffold a project config
vp config init

# Switch provider or model
vp config set provider openai
vp config set modelId gpt-4o

# Store API keys securely in the OS keyring
echo -n "$KEY" | vp provider store-key openai
```

See [`docs/SETUP.md`](docs/SETUP.md) for setup guides and [`docs/CONFIG.md`](docs/CONFIG.md) for all config keys and environment variables.

## Security & Output

- Descriptions in standard output are wrapped in `<vision_proxy_description>` fences with image metadata (`--no-fence` drops wrapping for debugging).
- When using `--json`, `records[].description` contains raw text; consumers should treat each description as independently untrusted.
- Output originates from external vision models and must be treated as UNTRUSTED by downstream agents.
- Image cropping, hashing, and URL downloads are handled locally before upload.
- Images are sent to the configured provider API (Anthropic, OpenAI, or Google); review your provider's data retention and privacy policies before sending sensitive images.
- URL downloads enforce SSRF restrictions against internal, loopback, and private network addresses.
- File paths must resolve to local filesystem paths (network shares are restricted by default).

## License

MIT
