# Quick start

Get from install to your first image description.

## 1. Install

### Homebrew (macOS / Linux)

```bash
brew tap tan-yong-sheng/vision-proxy https://github.com/tan-yong-sheng/vision-proxy
brew install tan-yong-sheng/vision-proxy/vision-proxy
```

### curl installer

```bash
curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh -s -- --add-to-path
```

### From source

```bash
git clone https://github.com/tan-yong-sheng/vision-proxy.git
cd vision-proxy
pnpm install
pnpm run build
npm link
```

## 2. Update

Updating depends on how you installed `vp`:

- **curl installer**: `vp update` (or `vp update --check` to preview, `vp update --version <tag>` to pin, `vp update --force` to reinstall).
- **Homebrew**: `brew upgrade vision-proxy`.
- **npm**: `npm install -g vision-proxy`.
- **Source build**: pull latest changes and run `npm run build`.

`vp` refreshes a cached release check in the background at most once a day and prints a one-line stderr notice when a newer version exists.
Set `VP_NO_UPDATE_NOTIFIER=1` to disable it; it is already suppressed during `vp hook`, with `--json`, in CI, and on non-interactive streams.

## 3. Set a provider

Configure the provider and its API key in `~/.vision-proxy/config.json` so every invocation, including agent hooks running in isolated subshells, picks them up:

```json
{
  "provider": "google",
  "apiKey": "AIzaSy..."
}
```

The same values via the CLI:

```bash
vp config set provider google
vp config set apiKey AIzaSy...
```

`apiKey` is stored as plain text.
For stronger handling, use `vp provider store-key google` to put the key in your OS keyring, or export the provider env var for a single session.

Per-provider defaults:

### Google

```bash
vp config set provider google
vp config set modelId gemini-2.5-pro
vp config set apiKey AIzaSy...      # or: export GOOGLE_API_KEY="AIzaSy..."
```

### OpenAI

```bash
vp config set provider openai
vp config set modelId gpt-4o
vp config set apiKey sk-...         # or: export OPENAI_API_KEY="sk-..."
```

### Anthropic

```bash
vp config set provider anthropic
vp config set modelId claude-sonnet-4-5
vp config set apiKey sk-ant-...     # or: export ANTHROPIC_API_KEY="sk-ant-..."
```

## 4. Analyze an image

```bash
vp analyze screenshot.png
```

## 5. (Optional) Add an agent integration

```bash
vp integration install claude-code
```

See [INTEGRATIONS.md](./INTEGRATIONS.md) for Codex and Pi.

## Next steps

- [Provider-specific guides](./providers/)
- [Full config reference](./CONFIG.md)
- [Setup index](./SETUP.md)
