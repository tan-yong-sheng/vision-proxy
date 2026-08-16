# ACP - Claude Code

Use Claude Code as an ACP agent for `vp`.

## Install the ACP wrapper

```bash
npm install -g @agentclientprotocol/claude-agent-acp
```

Or run it directly:

```bash
npx -y @agentclientprotocol/claude-agent-acp
```

## Configure `vp`

```bash
vp config set provider acp
vp config set acpCommand claude-agent-acp
```

Or paste this into `~/.vision-proxy/config.json`:

```json
{
  "provider": "acp",
  "acpCommand": "claude-agent-acp"
}
```

## Run

```bash
vp analyze screenshot.png
```

## Notes

- The wrapper uses the official Claude Agent SDK under the hood.
- The ACP provider does not support fallback models.
- Ensure you trust the binary before configuring it.
