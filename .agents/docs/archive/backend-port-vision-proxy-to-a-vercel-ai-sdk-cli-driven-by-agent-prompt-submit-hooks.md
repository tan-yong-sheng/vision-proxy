---
type: research
title: Port vision proxy to a Vercel AI SDK CLI driven by agent prompt-submit hooks
description: "Replace the Pi-specific extension with a portable Vercel AI SDK CLI, injected into any coding agent via UserPromptSubmit-style hooks."
area: backend
tags: [migration, vercel-ai-sdk, cli, hooks, vision, pi-extension]
status: complete
superseded_by: plans/backend-migrate-vision-proxy-to-vercel-ai-sdk-cli-driven-by-agent-userpromptsubmit-hooks
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-09-13"
related: []
---
# Port vision proxy to a Vercel AI SDK CLI driven by agent prompt-submit hooks

## Question

Can `pi-vision-proxy` (a Pi `@earendil-works/pi-coding-agent` extension that auto-describes attached images and injects the text into the agent's system prompt) be reimplemented as a standalone CLI using the Vercel AI SDK, and driven inside many coding agents through their native prompt-submit hooks (e.g. Claude Code `UserPromptSubmit`)? What is the real port/replace boundary, and what are the risks?

## Options considered

### Option A - Direct Pi -&gt; AI SDK rewrite inside Pi

Keep it a Pi extension, just swap `complete()` for AI SDK. Rejected: keeps the product locked to one agent framework and does not satisfy the "work in different agents" goal.

### Option B - Portable CLI + per-agent hook shims (recommended)

Two layers, both agent-agnostic:

1. A CLI core (Vercel AI SDK) doing the vision call. The Pi-free logic in `extensions/internal.ts` (hashing, crops, grounding formats, per-turn limits, config schema) and `lib/image-payloads.ts` (decode/validate) ports almost as-is. The only real swap is `complete()` -&gt; `generateText`/`generateObject`.
2. A thin per-agent hook shim (one small script per agent) that parses the hook's stdin, extracts image paths, shells out to the CLI, and prints the description to stdout. Follow herdr's "one binary, many shims" install pattern.

## Findings

### 1. Pi coupling is shallow except for four surfaces

Grep of `lib/` and `extensions/` shows `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` used as **type-only** imports in `internal.ts` and as runtime imports in exactly these surfaces:

- `complete()` (the vision LLM call) - `lib/image-payloads.ts` `callVisionModel`, `extensions/helpers/before-agent.ts` `executeJointDescription`.
- `ctx.modelRegistry.find()` + `getApiKeyAndHeaders()` (provider + auth lookup).
- Lifecycle events `session_start` / `before_agent_start` / `context` (`extensions/vision-proxy.ts`).
- `pi.registerTool()` / `pi.registerCommand()` and `pi.appendEntry` / `sessionManager.getEntries()` / `ctx.ui.notify` / `setStatus` (UX + session metadata).

Everything else - `hashImageData`, `resolveCropEntry`, `buildAnalyzeResult`, `buildDescriptionFence`, grounding-format logic (`qwen_pixels`, `molmo_points`, `deepseek_bbox`, `internvl_pixels`, `gemini_normalized_1000`), `VisionConfig`, `resolveConfig`, the pHash cache - has no Pi runtime dependency and moves as-is.

### 2. Vercel AI SDK multimodal `generateText` (verified, current API)

- Top-level options: `model`, `system` (string; maps to the original `systemPrompt`), `messages`, `prompt`, `providerOptions`, `maxOutputTokens`, `abortSignal`.
- `messages: [{ role: 'user', content: [...] }]` - content is an array of parts.
- Image part is now `{ type: 'file', mediaType: 'image', data: Buffer | Uint8Array | base64 | URL }`. The old `{ type: 'image', image: ... }` is deprecated but still accepted (rewritten internally to `FilePart`).
- **Auth is not per-call.** The API key lives at provider construction (`openai({ apiKey })`) or in env (`OPENAI_API_KEY`), unlike Pi's `complete(model, opts, { apiKey, headers })`. The CLI must resolve provider + key itself (env, or a small provider registry) rather than receiving them from a framework.
- `result.text` holds the output; `result.files` holds any generated images.
- Sources: vercel/ai docs (generateText chat prompt, Hugging Face local image input, Google multimodal, content-part migration 7.0, ImagePart/FilePart types).

### 3. The hook model is a structural match, not an approximation

Claude Code `UserPromptSubmit` fires after the user presses enter, before the model processes the message, and **its stdout is prepended to the user message as a system note**. That is functionally equivalent to the Pi extension's `before_agent_start` returning a `systemPrompt` addition: read prompt -&gt; detect image paths -&gt; analyze -&gt; inject description. The injection point differs (user-turn system note vs system prompt) but the behavior is the same. `UserPromptSubmit` hooks default to a 30s command budget (lower than other events), which bounds latency.

### 4. herdr is precedent, not substrate

herdr is an activity monitor (working/idle/blocked) that *consumes* agent hook systems. It writes a `herdr-agent-state.sh` shim into each agent's native config (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`, `~/.gemini/config/hooks.json`, etc.) mapping `UserPromptSubmit -> working`. So the thing we hook into is each agent's **native** hook system; herdr is the proof that "install a shim per agent's config format" is a viable, widely-supported pattern. We are not a dependency of herdr - we copy its install ergonomics.

### 5. Per-agent hook schemas differ; shims absorb it

Claude Code passes `prompt` on stdin JSON; Codex/Cursor/Gemini/Kimi/Qoder differ in field names and config file shape (herdr's `mod.rs` enumerates ~12 event sets across agents). Realistic shape is "one CLI, N shims," not zero per-agent code. The shim's job is tiny: parse stdin -&gt; `extractCandidateImagePaths`-equivalent -&gt; exec CLI -&gt; print description to stdout.

### 6. Injection = untrusted content (keep the safety fence)

The original explicitly wraps descriptions in `<vision_proxy_description>` tags and warns the model not to follow instructions inside them, because image-derived text is attacker-controlled. The CLI must emit the same fences on stdout. Auto-injecting unfenced model output would pipe attacker text into every prompt.

## Recommendation / decision

Option B: build a portable CLI on the Vercel AI SDK whose reusable core is lifted largely verbatim from `internal.ts` / `image-payloads.ts`, with `complete()` replaced by `generateText` (using `FilePart` image input and provider-constructed auth). Drive it from each agent's native `UserPromptSubmit`-style hook via a thin per-agent shim, mirroring herdr's install pattern. Preserve the description fences. Treat CLI-as-MCP-tool (Option C) as a later enhancement for crop/compare heavy cases, not the core.

Open decisions before a plan:

- CLI invocation model: cache-first single call within the 30s budget, or strip images and let the agent call the CLI explicitly for batches? (See risks.)
- Which agents to ship shims for first (Claude Code + Codex are the lowest-risk given herdr coverage).
- Config + provider registry: env-driven (`OPENAI_API_KEY` etc.) vs a file-based `VisionConfig` mirror.

## Risks / open questions

- **Latency vs 30s hook budget.** Single-image analysis with the pHash/per-image cache should fit; multi-image joint-batch passes may not. Need a clear strategy (cache-first, or offload heavy cases to an explicit tool call).
- **Where injected text lands** (user-turn system note vs system prompt) slightly changes the "UNTRUSTED" framing - deliberate decision, not accidental.
- **Provider/auth ownership.** AI SDK needs the key at provider construction; the CLI must own a small provider registry + env resolution, replacing Pi's `modelRegistry`.
- **Per-agent schema drift** means N shims; budget for that in the install tooling.
- **Self-analysis loops.** A hook that injects image descriptions could feed back into the agent's own output if not scoped to user-originated prompts only.

## Sources

- Vercel AI SDK docs (vercel/ai): generateText chat prompt, Hugging Face local image input, Google multimodal responses, content-part migration guide 7.0, ImagePart/FilePart type definitions.
- Claude Code hooks reference: `UserPromptSubmit` event semantics, stdout-as-system-note injection, 30s default budget, settings.json config.
- herdr (github.com/ogulcancelik/herdr) INTEGRATIONS.md + `src/integration/mod.rs`: per-agent hook event mapping and shim-install pattern across Claude Code, Codex, Cursor, Gemini, Kimi, Qoder, Devin, Copilot, Factory, Antigravity.
- Local: `pi-vision-proxy` source - `extensions/internal.ts`, `extensions/vision-proxy.ts`, `extensions/helpers/before-agent.ts`, `lib/image-payloads.ts`, `lib/analyze.ts`, `package.json`.

