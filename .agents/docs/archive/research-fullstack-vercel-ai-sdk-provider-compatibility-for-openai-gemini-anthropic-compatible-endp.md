---
type: research
title: Vercel AI SDK provider compatibility for openai/gemini/anthropic-compatible endpoints
description: Vercel AI SDK provider compatibility for openai/gemini/anthropic-compatible endpoints - one-line summary.
area: fullstack
tags: []
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-09-14"
related: []
---
# Vercel AI SDK provider compatibility for openai/gemini/anthropic-compatible endpoints

## Question

Can a user point `vp` at any OpenAI/Anthropic/Google-compatible endpoint (e.g. a local proxy like ollama, vllm, or litellm) without code changes?

## Findings

**Yes — all three Vercel AI SDK providers already support `baseURL` overrides.**

| Provider | Factory | `baseURL` supported? | Env var |
|----------|---------|---------------------|--------|
| `@ai-sdk/openai` | `createOpenAI({ apiKey, baseURL })` | Yes | `OPENAI_BASE_URL` |
| `@ai-sdk/anthropic` | `createAnthropic({ apiKey, baseURL })` | Yes | `ANTHROPIC_BASE_URL` |
| `@ai-sdk/google` | `createGoogleGenerativeAI({ apiKey, baseURL })` | Yes | `GOOGLE_BASE_URL` |

Each factory accepts `baseURL` as an optional parameter in its constructor options. The `vp` CLI already wires this through:

```ts
// src/provider.ts
make: ({ apiKey, modelId, baseURL }) =>
  createOpenAI({ apiKey, baseURL })(modelId),
```

So a user running a local OpenAI-compatible proxy (e.g. `vllm serve ... --api-key openai`) can:

```bash
export OPENAI_BASE_URL="http://localhost:8000/v1"
vp analyze screenshot.png --provider openai
```

No code change needed. The same applies for `ANTHROPIC_BASE_URL` and `GOOGLE_BASE_URL` — they are already plumbed through.

## Implication for docs

- `docs/SETUP.md` should document `*_BASE_URL` as the way to use a local proxy.
- The `provider list` output already shows these env vars.

## Open questions

None — support is confirmed.
