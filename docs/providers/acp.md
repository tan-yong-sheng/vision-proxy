# ACP setup

The ACP (Agent Client Protocol) provider routes image analysis through an ACP-compatible agent process instead of a direct API key.

Supported agent processes include Claude Code, Gemini CLI, and Codex CLI when run in ACP mode.

## Prerequisites

- An installed ACP-compatible agent (for example, `claude-code-acp`, `gemini`, or `codex`).
- A subscription or credentials that the agent itself manages.

## Configure `vp`

```bash
vp config set provider acp
vp config set acpCommand gemini
vp config set acpArgs '["--experimental-acp"]'
```

Or write the full config to `~/.vision-proxy/config.json`:

```json
{
  "provider": "acp",
  "acpCommand": "gemini",
  "acpArgs": ["--experimental-acp"]
}
```

## ACP configuration keys

| Key | Description |
|-----|-------------|
| `acpCommand` | The agent executable (for example, `gemini`, `claude-code-acp`). |
| `acpArgs` | CLI arguments as a JSON array, for example `["--experimental-acp"]`. |
| `acpCwd` | Working directory for the spawned agent process. |
| `acpMcpServers` | MCP server configurations as a JSON array. |

## Run

```bash
vp analyze screenshot.png
```

When the provider is `acp`, the `model` config key is ignored because the agent selects its own model.

## Security note

The ACP provider executes a user-supplied binary.
Ensure you trust the command before configuring it.
