# Quick start

Get from install to your first image description in a few minutes.

## 1. Install

```bash
npm install -g vision-proxy
```

Or clone and link:

```bash
git clone https://github.com/tan-yong-sheng/vision-proxy.git
cd vision-proxy
pnpm install
pnpm run build
npm link
```

## 2. Pick a provider

Choose one provider and set its API key.

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

### ACP (agent process)

```bash
vp config set provider acp
vp config set acpCommand gemini
vp config set acpArgs '["--experimental-acp"]'
```

## 3. Analyze an image

```bash
vp analyze screenshot.png
```

You should see a fenced description in stdout.

## 4. (Optional) Install an agent integration

```bash
vp integration install claude-code
vp integration install codex
vp integration install pi
```

See the [integrations](./integrations/) guides for details.

## Next steps

- Read the [provider-specific setup guides](./providers/).
- See the full [config reference](./CONFIG.md).
- Store API keys in the OS keyring with `vp provider store-key`.
