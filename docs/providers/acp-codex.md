# ACP - Codex

Use OpenAI Codex as an ACP agent for `vp`.

## Install the ACP wrapper

```bash
npm install -g @agentclientprotocol/codex-acp
```

Or run it directly:

```bash
npx -y @agentclientprotocol/codex-acp
```

The wrapper ships with a compatible `@openai/codex` dependency.
Set `CODEX_PATH` only if you want it to use a different Codex binary.

## Authentication

The wrapper can authenticate via ChatGPT login, an API key, or a custom gateway.
For API-key auth, set:

```bash
export OPENAI_API_KEY="sk-..."
# or
export CODEX_API_KEY="sk-..."
```

## Configure `vp`

```bash
vp config set provider acp
vp config set acpCommand codex-acp
```

Or paste this into `~/.vision-proxy/config.json`:

```json
{
  "provider": "acp",
  "acpCommand": "codex-acp"
}
```

## Run

```bash
vp analyze screenshot.png
```

## Notes

- The ACP provider does not support fallback models.
- Ensure you trust the binary before configuring it.
