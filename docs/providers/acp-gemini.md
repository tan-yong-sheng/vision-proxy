# ACP - Gemini

Use Google Gemini CLI as an ACP agent for `vp`.

## Install Gemini CLI

Install the Gemini CLI and ensure `gemini` is on your PATH.

## Configure `vp`

```bash
vp config set provider acp
vp config set acpCommand gemini
vp config set acpArgs '["--acp"]'
```

Or paste this into `~/.vision-proxy/config.json`:

```json
{
  "provider": "acp",
  "acpCommand": "gemini",
  "acpArgs": ["--acp"]
}
```

## Run

```bash
vp analyze screenshot.png
```

## Notes

- Gemini CLI has native ACP support via the `--acp` flag.
- The ACP provider does not support fallback models.
- Ensure you trust the binary before configuring it.
