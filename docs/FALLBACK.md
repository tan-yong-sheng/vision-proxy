# Fallback models

`vp` can try a chain of backup models when the primary model fails.

## How it works

Set `fallbackModels` to an ordered list of `provider/model-id` strings.
If the primary model call fails, `vp` tries each fallback in order.

A missing API key on the primary provider is still a fatal error; fallbacks only help when the model call itself fails.

## Format

```json
{
  "provider": "openai",
  "modelId": "gpt-4o",
  "fallbackModels": [
    "openai/gpt-4o-mini",
    "anthropic/claude-sonnet-4-5"
  ]
}
```

Or set via env var:

```bash
VP_FALLBACK_MODELS="openai/gpt-4o-mini" vp analyze screenshot.png
```

Or use the CLI:

```bash
vp config set fallbackModels '["openai/gpt-4o-mini"]'
```

## Same-provider vs. cross-provider

- **Same-provider** fallbacks are usually simpler because you only need one API key configured.
- **Cross-provider** fallbacks are useful when one provider is rate-limited or down.

## ACP

The ACP provider does **not** support fallback models.
If `provider` is `acp`, `fallbackModels` is ignored.
