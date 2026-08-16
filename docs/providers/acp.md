# ACP

The ACP (Agent Client Protocol) provider routes image analysis through an ACP-compatible agent process instead of an API key.

Supported agents include Claude Code, Gemini CLI, and Codex CLI when run in ACP mode.

## Quick config

```bash
vp config set provider acp
vp config set acpCommand gemini
vp config set acpArgs '["--experimental-acp"]'
```

Or paste this into `~/.vision-proxy/config.json`:

```json
{
  "provider": "acp",
  "acpCommand": "gemini",
  "acpArgs": ["--experimental-acp"]
}
```

## Run

```bash
vp analyze screenshot.png
```

When the provider is `acp`, the `modelId` config key is ignored because the agent selects its own model.

## Options

| Key | Description |
|-----|-------------|
| `acpCommand` | The agent executable (for example, `gemini`, `claude-code-acp`). |
| `acpArgs` | CLI arguments as a JSON array. |
| `acpCwd` | Working directory for the spawned agent process. |
| `acpMcpServers` | MCP server configurations as a JSON array. |

## Security note

The ACP provider executes a user-supplied binary.
Ensure you trust the command before configuring it.
