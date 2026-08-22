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

## 2. Set a provider

Pick one provider and set its API key.

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
vp config set provider openai
vp config set modelId gpt-4o
```

### Anthropic

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
vp config set provider anthropic
vp config set modelId claude-sonnet-4-5
```

### Google

```bash
export GOOGLE_API_KEY="..."
vp config set provider google
vp config set modelId gemini-2.5-pro
```

## 3. Analyze an image

```bash
vp analyze screenshot.png
```

## 4. (Optional) Add an agent integration

```bash
vp integration install claude-code
```

See [INTEGRATIONS.md](./INTEGRATIONS.md) for Codex and Pi.

## Next steps

- [Provider-specific guides](./providers/)
- [Full config reference](./CONFIG.md)
- [Setup index](./SETUP.md)
