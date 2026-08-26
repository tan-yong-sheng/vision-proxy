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

## Updating

How you update depends on how you installed vision-proxy:

- **curl installer** (`~/.local/share/vision-proxy`): `vp` self-updates in place.
  - `vp update` checks for a newer release and installs it.
  - `vp update --check` (`-c`) reports whether an update is available without modifying anything.
  - `vp update --version <tag>` installs a specific release (e.g. `vp update --version v0.1.0`).
  - `vp update --force` (`-f`) reinstalls even when already on the latest.
  - `vp update --beta` installs the latest pre-release instead of the latest stable (combines with `--check` and `--force`).
- **Homebrew**: `brew upgrade vision-proxy`.
- **npm**: `npm install -g vision-proxy`.
- **Source build**: pull latest changes and run `npm run build`.

`vp update` detects your install method automatically and prints the right command if it cannot self-update.

`vp` also checks for new releases in the background (at most once every 24 hours) and prints a one-line notice on stderr when one is available.
The check never blocks a command, and is skipped during `vp hook`, with `--json`, in CI, and when stderr is not a terminal.
Set `VP_NO_UPDATE_NOTIFIER=1` to turn it off entirely.

## Quick start

1. Configure a provider and API key in `~/.vision-proxy/config.json`:

```json
{
  "provider": "google",
  "apiKey": "AIzaSy..."
}
```

Or set the same values from the CLI:

```bash
vp config set provider google
vp config set apiKey AIzaSy...
```

Because this file is read on every invocation, agents that run `vp hook` in isolated subshells pick the settings up automatically.
Prefer `vp provider store-key google` to keep the key in your OS keyring instead of plain text, or export `GOOGLE_API_KEY` for a single session.

2. Analyze an image:

```bash
vp analyze screenshot.png
```

`provider` accepts `google`, `openai`, or `anthropic`; see [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for per-provider settings.

## Agent Integrations

Install `vp` into your coding agent so it automatically analyzes images from prompts and tool calls:

```bash
# Install integration for your agent
vp integration install claude-code
vp integration install codex
vp integration install pi
vp integration install opencode

# Check installed integrations and version status
vp integration status

# Remove an integration
vp integration uninstall <agent>
```

- **Claude Code & Codex**: Registers `UserPromptSubmit` and `PreToolUse Read` hooks that invoke `vp hook`. For Claude Code, `UserPromptSubmit` also resolves pasted/attached images (rendered as `[Image #N]` refs) via the session-scoped `image-cache`.
- **Pi**: Installs a `vision-proxy.ts` extension into `~/.pi/agent/extensions/` that hooks into Pi's `input`, `context`, and `tool_result` lifecycle events to analyze attached and referenced images at send-time without blocking prompt submission.

Caveat: For Claude Code, images can only be referenced by file path in the user prompt. It does not support rendering `[Image #N]` because the `UserPromptSubmit` hook cannot modify the user prompt before it is sent to the LLM API.

See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for troubleshooting and details.

## Commands

| Command | Description |
|---------|-------------|
| `vp analyze <paths...>` | Describe one or more images (`--crop`, `--format`, `--json`, `--model`, `--provider`, `--no-fence`). |
| `vp integration <cmd> [agent]` | Manage agent integrations (`install`, `status`, `list`, `show`, `uninstall`). |
| `vp config <cmd>` | Manage configuration (`init`, `get`, `set`, `validate`). |
| `vp provider <cmd>` | Manage provider auth and keys (`list`, `check`, `store-key`, `delete-key`, `list-keys`). |
| `vp cache <cmd>` | Manage perceptual-hash description cache (`status`, `clear`, `prune`). |
| `vp update [--check] [--version <tag>] [--force]` | Self-update (curl install) or print package-manager guidance. |

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

Set `VP_NO_UPDATE_NOTIFIER=1` to suppress the background update notice.

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
