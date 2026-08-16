---
type: worktree
title: Vision proxy CLI core
description: "Scaffold the vision-proxy CLI, port Pi-free core, and implement analyze/config/provider/cache commands on the Vercel AI SDK."
area: backend
tags: [worktree, cli, vercel-ai-sdk, vision]
status: landed
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-08-28"
related:
  - ../plans/backend-migrate-vision-proxy-to-vercel-ai-sdk-cli-driven-by-agent-userpromptsubmit-hooks.md
---

# Vision proxy CLI core

## Objective

Build the standalone `vision-proxy` / `vp` CLI and its core commands so that image analysis is no longer tied to the Pi extension runtime.

## Scope

- Scaffold a new CLI package (Node 22+, `--experimental-strip-types`) with dependency on `ai` and provider SDKs such as `@ai-sdk/openai`.
- Port the Pi-free helpers from `extensions/internal.ts` and `lib/image-payloads.ts`:
  - image hashing, metadata, and crop resolution
  - grounding formats (`qwen_pixels`, `molmo_points`, `deepseek_bbox`, `internvl_pixels`, `gemini_normalized_1000`)
  - per-turn limits and config schema
  - pHash / per-image cache
- Implement the Vercel AI SDK adapter using `FilePart` with concrete `image/*` media types.
- Implement the `analyze` command with cache-first single-image path and explicit `--joint` offload.
- Implement `config`, `provider`, and `cache` subcommands.
- Preserve the safety fence (`<vision_proxy_description>`) by default.
- Add unit tests for pure helpers and integration tests for the CLI.

## Branch

- Worktree branch: `vp-cli-core`
- Base branch: `configurable-analyze-image-limit`
- Depends on: none (this is the first vertical slice).

## Verification

- Local checks:
  - `node --experimental-strip-types --no-warnings --test ...`
  - `npx tsc --noEmit`
- `/review-gate` (medium risk — new CLI surface and provider auth).

## Status

active
