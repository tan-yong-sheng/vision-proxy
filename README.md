# vision-proxy

A standalone CLI that routes images to a vision-capable model and prints a fenced, UNTRUSTED description.

It is designed to be called from agent `UserPromptSubmit` hooks so any coding agent can "see" images in a prompt.

## Install

vision-proxy ships prebuilt per-OS/arch tarballs from [GitHub Releases](https://github.com/tan-yong-sheng/vision-proxy/releases). Pick either install path below; both pull the same artifacts.

### Homebrew (macOS / Linux)

```bash
brew tap tan-yong-sheng/vision-proxy https://github.com/tan-yong-sheng/vision-proxy
brew install tan-yong-sheng/vision-proxy/vision-proxy
```

This installs the `vp` binary and pulls in Node 22 as a dependency.
The formula's per-arch `sha256` values are filled automatically from each
release's `sha256sum.txt` when that release is published, so `brew install`
always matches the published artifacts.

### curl installer (no Homebrew)

```bash
curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh
```

The installer detects your OS/arch, downloads the matching release tarball, verifies its SHA-256 against the published `sha256sum.txt`, extracts into `~/.local/share/vision-proxy`, and symlinks `vp` into `~/.local/bin`.

It depends only on POSIX tools (`curl`, `awk`, and `sha256sum`/`shasum`); `jq` is **not** required.
If `~/.local/bin` is not already on your `PATH`, the installer prints the exact `export` line to add, or you can pass `--add-to-path` to append it to your shell profile (`.bashrc`, `.zshrc`, or `config.fish`) automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh -s -- --add-to-path
```

### Pre-releases

The default curl installer follows the latest **stable** GitHub release, and the Homebrew formula always tracks stable releases.
To test a pre-release (for example `v0.1.0-rc.1`), pin the tag with `--version`:

```bash
curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh -s -- --version v0.1.0-rc.1
```

Pre-release tarballs are also available directly from the [GitHub Releases](https://github.com/tan-yong-sheng/vision-proxy/releases) page.

### Requirements

Requires Node 22 or later on `PATH` (the Homebrew formula satisfies this automatically; the curl installer prints a warning if your system Node is older).

> Prefer a single static binary with no Node dependency? Standalone `bun build --compile` binaries (Track B) are planned as a fast-follow and will land in the same releases.

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
| `VP_MAX_IMAGES_PER_CALL` | Max images per analysis call (1-20) | `4` |
| `VP_MAX_BATCH` | **Deprecated.** Alias for `VP_MAX_IMAGES_PER_CALL` | `4` |
| `VP_CACHE_SIZE` | Number of cached descriptions (0-500) | `50` |
| `VP_CACHE_MAX_AGE_DAYS` | Stale entries older than this are lazily evicted on cache access (0-3650) | `30` |
| `VP_PHASH_THRESHOLD` | Perceptual-hash similarity threshold (0-1) | `0.8` |
| `*_BASE_URL` | Provider-specific base URL override (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_BASE_URL`) | unset |
| `VP_BASE_URL` | Base URL override for the active provider (e.g. `http://localhost:8000/v1`) | unset |
| `VP_MAX_IMAGE_BYTES` | Max image file size in bytes | `10485760` (10 MB) |
| `VP_DOWNLOAD_TIMEOUT` | HTTP download timeout in milliseconds | `30000` (30 s) |
| `VP_STRICT_MIME` | Set to `1`, `true`, `yes`, or `on` to reject images whose extension doesn't match actual content | unset (lenient) |
| `VP_ALLOW_DRIVES` | Set to `0`/`false`/`no`/`off` to disable local drive access on Windows | unset (drives allowed) |
| `VP_MAX_OUTPUT_TOKENS` | Cap response tokens from `vp hook` (Codex preview limit) | `2000` |
| `VP_CACHE_DIR` | Directory for the description cache | `~/.vision-proxy` |
| `VP_HOOK_TIMEOUT_MS` | `vp hook` timeout in milliseconds | `30000` |
| `VP_BIN` | Path to the `vp` binary used by `vp hook` | `vp` |
| `VP_KEYRING` | Set to `0`, `false`, or `off` to disable OS keyring credential storage | unset (keyring enabled) |

Provider API keys are read from their standard environment variables: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY`.
When a key is absent from the environment, `vp` checks the OS keyring as a fallback via `@napi-rs/keyring`.

Image paths can be local absolute file paths or `http://` / `https://` URLs. URLs are downloaded with a 30 s timeout (configurable via `VP_DOWNLOAD_TIMEOUT`), size-limited to 10 MB (configurable via `VP_MAX_IMAGE_BYTES`), and content-sniffed via Sharp to detect the actual format. Set `VP_STRICT_MIME=1` to reject files where the extension mismatches the detected content.

Supported image formats (via Sharp): PNG, JPEG, GIF, WebP, TIFF, AVIF. BMP and ICO files are detected but cannot be used as input for cropping; they are sent to the model as-is.

### Configuration keys

Most settings are set with `vp config set <key> <value>` (written to `.vision-proxy.json` or `~/.vision-proxy/config.json`).

- `baseUrl` - a single base URL override for the current provider, e.g. `vp config set baseUrl http://localhost:8000/v1`.
  The provider-specific `*_BASE_URL` env vars take precedence over this config value. `VP_BASE_URL` is the equivalent environment override.

A missing API key on the primary provider is always a fatal error.

## Commands

- `vp analyze <paths...>` - describe one or more images.
- `vp config init|get|set|validate` - manage config files.
- `vp provider list|check|store-key|delete-key|list-keys` - manage provider registrations and keys.
- `vp cache status|clear|prune` - inspect and clear the local description cache.
- `vp integration install|show|list|status|uninstall <agent>` - install vision-proxy for `pi`, `claude-code`, or `codex`.

## Agent hooks

Install hooks so Claude Code or Codex automatically describes images both when you mention a path in your prompt and when you read an image via the `Read` tool:

```bash
vp integration install claude-code
vp integration install codex
```

Each agent registers two hooks (`UserPromptSubmit` and `PreToolUse Read`) that invoke the absolute `vp hook` path. `vp hook` reads the event from stdin, runs `vp analyze` on any image it finds, and returns the fenced description as additional hook context. On any error it fails open (exit 0, no output), so the agent proceeds unchanged.

## Pi integration

Pi users can install a `analyze_image` tool backed by the CLI:

```bash
vp integration install pi
```

This writes a single auto-discovered extension into `~/.pi/agent/extensions/vision-proxy.ts`. The generated extension shells out to `vp analyze --json`, reads `VP_BIN` from the environment (falling back to `vp` on `PATH`), and fails open if `vp` is missing. Re-run the installer after a CLI upgrade to refresh the extension, and use `vp integration uninstall pi` to remove it.

Every installed integration (the Pi extension and the Claude Code / Codex hooks) is stamped with the `vp` version that produced it. Run `vp integration status` to list installed integrations alongside their version markers; any integration whose marker predates the installed `vp` is flagged so you know to re-run `vp integration install`.

## Output

Descriptions are wrapped in `<vision_proxy_description>` fences with metadata such as `image_index`, `width`, `height`, and `filename`.

The output is UNTRUSTED: it comes from an external vision model and must be treated as untrusted input by the downstream agent.

## Privacy and security

- Images are sent to the configured provider's API.
- Crops are applied locally before upload; only the cropped region is sent.
- Image paths are restricted to local absolute paths (not network shares) by default; Windows drive access is controlled by `VP_ALLOW_DRIVES`.
- URLs are downloaded locally first; no image bytes are sent to the provider until after download, size check, and content sniffing.
- URL downloads block internal hosts (loopback, private, link-local, and cloud-metadata ranges) and re-validate every redirect hop.
- Review your provider's privacy policy before sending sensitive images.

## CI security checks

- **OSV-Scanner** runs on every pull request to `main` and reports only newly introduced dependency vulnerabilities.
- A **scheduled weekly scan** runs a full vulnerability sweep and uploads SARIF results to the GitHub Security tab.
- **BetterLeaks** scans for accidental secret exposure on every CI run.
- Dependency vulnerabilities are managed via `osv-scanner.toml`; accepted risks are tracked with expiry dates.

## License

MIT
