---
type: plan
title: Migrate vision proxy to Vercel AI SDK CLI driven by agent UserPromptSubmit hooks
description: Deprecate the Pi extension; rewrite the vision core on the Vercel AI SDK and ship it as a portable CLI driven by per-agent UserPromptSubmit hooks.
area: backend
tags: [migration, vercel-ai-sdk, cli, hooks, vision]
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-10-13"
related:
  - research-backend-port-vision-proxy-to-a-vercel-ai-sdk-cli-driven-by-agent-prompt-submit-hooks
supersedes: research-backend-port-vision-proxy-to-a-vercel-ai-sdk-cli-driven-by-agent-prompt-submit-hooks
visual: .lavish/vision-proxy-cli-plan.html
---

# Migrate vision proxy to Vercel AI SDK CLI driven by agent UserPromptSubmit hooks

## Goal capsule

Drop the Pi `@earendil-works/pi-coding-agent` extension entirely. Rebuild the reusable vision core on the Vercel AI SDK and expose it as a standalone CLI (`vision-proxy`, alias `vp`) that any coding agent can drive via its native `UserPromptSubmit`-style hook. The CLI auto-detects images in the user prompt, analyzes them, and prints a fenced description to stdout, which the hook prepends as a system note.

This plan supersedes [research-backend-port-vision-proxy-to-a-vercel-ai-sdk-cli-driven-by-agent-prompt-submit-hooks](../archive/backend-port-vision-proxy-to-a-vercel-ai-sdk-cli-driven-by-agent-prompt-submit-hooks.md), which chose Option B. Option B is now the committed direction.

## Current state

`pi-vision-proxy` is a Pi extension. Its Pi coupling is shallow and concentrated in four surfaces (from the research):

- `complete()` — the vision LLM call (in `lib/image-payloads.ts` `callVisionModel`, `extensions/helpers/before-agent.ts` `executeJointDescription`).
- `ctx.modelRegistry.find()` + `getApiKeyAndHeaders()` — provider + auth lookup.
- Lifecycle events `session_start` / `before_agent_start` / `context` (`extensions/vision-proxy.ts`).
- `pi.registerTool()` / `pi.registerCommand()` and `pi.appendEntry` / `sessionManager.getEntries()` / `ctx.ui.notify` / `setStatus` — UX + session metadata.

Everything else is Pi-free and ports as-is: `hashImageData`, `resolveCropEntry`, `buildAnalyzeResult`, `buildDescriptionFence`, the five grounding formats (`qwen_pixels`, `molmo_points`, `deepseek_bbox`, `internvl_pixels`, `gemini_normalized_1000`), `VisionConfig`, `resolveConfig`, and the pHash cache.

## Target state

A portable CLI + thin per-agent hook shims. Two agent-agnostic layers:

1. **CLI core (Vercel AI SDK).** The Pi-free logic from `extensions/internal.ts` and `lib/image-payloads.ts` (hashing, crops, grounding formats, per-turn limits, config schema, decode/validate) ports almost verbatim. The only real swap is `complete()` -> `generateText` / `generateObject` using `FilePart` image input (`{ type: 'file', mediaType: 'image/png', data: <Buffer> }`). Note that the older `ImagePart` (`type: 'image'`) is deprecated in the AI SDK; `FilePart` with a concrete `image/*` media type is the current shape. Provider-specific image options such as OpenAI `imageDetail` can be passed via `providerOptions` at the part level.
2. **Per-agent hook shim.** One small script per agent that parses the hook's stdin, extracts image paths, shells out to the CLI, and prints the description to stdout. Mirrors herdr's "one binary, many shims" install pattern.

Auth is owned by the CLI: the API key lives at provider construction (`openai({ apiKey })`) or in env (`OPENAI_API_KEY`), unlike Pi's per-call `complete(model, opts, { apiKey, headers })`. The CLI must resolve provider + key itself.

## Research findings

### Agent hook capability

Both target agents support the shim pattern, but their output contracts differ:

- **Claude Code** - `UserPromptSubmit` fires once per user turn.
  - Input includes `prompt` (the user prompt text) and common hook fields.
  - Output JSON uses the key `additionalContext` (the Elixir source maps the struct field `additional_context` to wire key `additionalContext`).
  - It can also return common output fields such as `systemMessage`, `continue`, `stopReason`, and `suppressOutput`.
- **Codex CLI** - `UserPromptSubmit` is a first-class hook event.
  - Input includes `prompt` plus common fields.
  - Plain text on stdout is added as extra developer context.
  - JSON on stdout supports common output fields and `hookSpecificOutput.additionalContext`.
  - A hook can block the prompt by returning `{"decision": "block", ...}` or exiting with code `2`.
  - Default hook timeout is `600` seconds, but each handler can declare its own `timeout`.
  - Hook output is limited to roughly `2500` tokens by default; larger output is spilled to disk and only a preview is sent to the model unless `additionalContextLimit` is raised.

This means the shim can be a tiny wrapper that shells out to `vp analyze`, parses the JSON result, and prints the additional context. The biggest agent-specific constraint is the **~2500-token output budget** on Codex, so the CLI must be able to cap or truncate descriptions.

### Vercel AI SDK image input

- `ImagePart` (`type: 'image'`) is **deprecated**. The current shape is `FilePart` with `mediaType: 'image'` (or a specific subtype such as `image/png`).
- `FilePart` fields: `type: 'file'`, `data` (base64 string, `Uint8Array`, `Buffer`, `ArrayBuffer`, `URL`, or `FileData`), `mediaType` (required), and optional `filename`.
- `generateText` / `generateObject` accept a `messages` array where a `UserModelMessage.content` can be an array of `TextPart | FilePart` parts.
- Provider-specific image options, such as OpenAI `imageDetail`, can be attached at the message-part level via `providerOptions`.

Therefore the adapter should send images as `FilePart` with a concrete `image/*` media type, not the deprecated `ImagePart`.

### Hook output contract

The per-agent shim owns the following behavior:

- **Success** - print the fenced description as `additionalContext` in the agent's expected JSON shape.
- **No images detected** - exit `0` with no stdout; the agent proceeds unchanged.
- **Timeout / failure** - fail open: exit `0` with no stdout, write diagnostics to `stderr`, and let the agent proceed. The hook itself is responsible for enforcing a timeout (e.g. `30` seconds) so it does not exhaust the agent's turn budget.
- **Token cap** - the CLI should accept a `--max-tokens` / `--max-output-tokens` flag and, when invoked from a Codex shim, default to a value that fits inside Codex's default preview limit (e.g. `2000` tokens) unless the user overrides it.

### Migration boundary

The existing Pi extension will be kept during the transition so current users are not broken.
The CLI and the Claude Code shim become the recommended path first.
Once the CLI reaches feature parity and the hook install flow is documented, the Pi extension will be marked deprecated and eventually removed in a follow-up plan.

### Config resolution order

From highest to lowest precedence:

1. CLI flags (e.g. `--provider`, `--model`, `--max-output-tokens`).
2. Environment variables (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VP_MODEL`).
3. Project-local config file (e.g. `.vision-proxy.json` in the working directory).
4. User config file (e.g. `~/.vision-proxy/config.json`, falling back to the existing `~/.pi/agent/vision-proxy.json` for continuity).
5. Built-in defaults (lowest).

Per-agent shim overrides are passed as CLI flags and therefore sit at precedence level 1.

### Cache key semantics

Cached descriptions must be invalidated when anything that could change the output changes.
The cache key for a single image should include:

- Image content identifier (`sha256` of the bytes, or pHash for fuzzy matching).
- Effective vision prompt / system prompt fingerprint.
- Provider + model identifier.
- Grounding format (if any).
- Crop region (if any).

For the initial implementation, use a stable content hash plus a composite string of the other parameters. Keep the existing pHash cache as an optional fuzzy layer, but do not let fuzzy hits return a description generated for a different prompt or model.

## Key technical decisions

### CLI command tree

```
vision-proxy  (alias: vp)
  analyze     Core: analyze image(s), print fenced description to stdout
    <paths...>            image paths (positional)
    --format <name>       plain | qwen_pixels | molmo_points | deepseek_bbox | internvl_pixels | gemini_normalized_1000
    --provider <name>     override provider
    --model <id>          override model
    --joint               joint multi-image batch (executeJointDescription)
    --crop <x,y,w,h>      crop before analysis (resolveCropEntry)
    --no-fence            drop <vision_proxy_description> fence (debug only)
    --config <path>       config override
    --json                machine-readable output for shims
  config     Manage VisionConfig
    init                   scaffold config file
    get                    print resolved config
    set <k> <v>            set a key
    validate               check config + provider reachability
  cache      pHash / per-image cache
    status                 hit rate + size
    clear                  drop all
    prune [--older <d>]    evict stale entries
  provider   Provider registry + auth (replaces Pi modelRegistry)
    list                   configured providers
    add <name>             register provider + key/env
    check [<name>]         verify auth
  hook       Per-agent shim install (herdr-style)
    install <agent>        claude-code | codex | cursor | gemini | ...
    list                   installed shims
    show <agent>           print shim for manual install
    uninstall <agent>
  completion  Shell completion
  version / help
```

### Encoded research decisions

- **Safety fence is on by default.** `analyze` emits `<vision_proxy_description>` tags; `--no-fence` is the only escape hatch. Image-derived text is attacker-controlled, so unfenced output must never be injected.
- **Cache-first single-image default.** `analyze` defaults to the pHash/per-image cache path, which fits the 30s hook budget. `--joint` is the explicit offload for multi-image batches that may exceed the budget. This encodes the "cache-first single call vs explicit batch" open question as a flag.
- **`config` + `provider` split resolution.** Env (`OPENAI_API_KEY` etc.) owns keys; the file `VisionConfig` owns format defaults and per-turn limits.
- **`hook install` touches agent config.** Ship `claude-code` + `codex` first (lowest risk per herdr coverage). `show` lets a user paste the shim manually if they do not want the CLI editing `~/.claude/settings.json`.

### Naming note

`vision-proxy` / `vp` is retained for product continuity and because "proxy" accurately means "proxies images into text," not "forwards HTTP." Documentation must state this explicitly so newcomers do not look for a server.

## Deliverables

- Reusable core module (ported verbatim from `internal.ts` / `image-payloads.ts`): hashing, crops, grounding formats, per-turn limits, config schema, decode/validate, pHash cache.
- Vercel AI SDK adapter replacing `complete()` with `generateText`/`generateObject` + `FilePart` input and provider-constructed auth.
- CLI binary `vision-proxy` with the command tree above (subcommands: `analyze`, `config`, `cache`, `provider`, `hook`, `completion`).
- Provider registry + env resolution replacing Pi's `modelRegistry`.
- Per-agent shims for Claude Code and Codex first; cursor/gemini/copilot/etc. follow.
- Fenced-output emitter preserved from the original.

## Build steps

1. Scaffold the CLI package and dependency on `ai` + provider SDKs (e.g. `@ai-sdk/openai`).
2. Port the Pi-free core (`internal.ts`, `image-payloads.ts` decode/validate) into the CLI, no Pi imports.
3. Implement the Vercel AI SDK adapter: `FilePart` image input, `generateText`/`generateObject`, provider-constructed auth.
4. Implement `analyze` with cache-first single-image path + `--joint` offload; wire the fence emitter.
5. Implement `config` + `provider` (env + file resolution).
6. Implement `cache` (pHash/per-image cache ops).
7. Implement `hook` install/`show`/`list`/`uninstall` for claude-code and codex; later agents follow the same shim shape.
8. Implement the adapter using `FilePart` with concrete `image/*` media types; avoid the deprecated `ImagePart`. Add optional `providerOptions` passthrough for per-provider image settings such as OpenAI `imageDetail`.
9. End-to-end test: a real image path through `vp analyze`, then through a Claude Code `UserPromptSubmit` hook, confirming the fenced description lands as a system note.

## Risks

- **Latency vs 30s hook budget.** Single-image with cache should fit; multi-image `--joint` may not. The cache-first default + explicit `--joint` offload is the mitigation. The shim should enforce its own timeout and fail open.
- **Codex output token limit.** Codex caps model-visible hook output at roughly 2500 tokens by default. The CLI must support a `--max-output-tokens` cap so descriptions fit; otherwise Codex will spill output to disk and only show a preview.
- **Injection framing.** User-turn system note vs system prompt changes the "UNTRUSTED" framing slightly; the fence must stay on by default.
- **Provider/auth ownership.** AI SDK needs the key at provider construction; the CLI must own a small registry + env resolution, replacing Pi's `modelRegistry`.
- **Per-agent schema drift.** N shims; budget for it in the install tooling.
- **Self-analysis loops.** The hook must scope injection to user-originated prompts only, never the agent's own output.

## Tools / MCP / Skills

- **Native tools:** Read, Edit, Write, Bash (scaffold, build, run CLI, install hooks).
- **MCP servers:** `context7` — verify current Vercel AI SDK `generateText` / `FilePart` API and content-part migration before finalizing the adapter.
- **Agent skills:** none required for the initial build; herdr is reference precedent only (per-agent shim install pattern), not a dependency.
