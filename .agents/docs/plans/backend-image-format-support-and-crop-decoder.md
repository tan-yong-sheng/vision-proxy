---
type: plan
title: image-format-support-and-crop-decoder
description: Align vp's claimed format support with actual decoder capability - replace imagescript crop decoder with sharp to support full EXT_TO_MIME set, add content sniffing, implement URL input or remove from help, add transient retry
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
stale_after: "2026-10-17"
related:
  - ../research/backend-image-format-crop-decoder-gap.md
---
# image-format-support-and-crop-decoder

## Goal capsule

Ensure `--crop` works for every format `vp` claims to support (png, jpg, jpeg, gif, webp, bmp, tiff, tif, ico, avif), add content-based mime validation on read, decide on URL input, and make provider calls resilient to transient errors.

## Current state

- **Read path**: extension-only, works for all 10 formats, no content validation
- **Crop path**: `imagescript` only handles PNG/JPEG/TIFF (and TIFF crashes in WASM); GIF uses wrong decoder class; WebP/BMP/ICO/AVIF unsupported → generic "crop failed"
- **End-to-end**: Gemini accepts all 10 formats including TIFF (despite docs)
- **URL input**: documented but unimplemented ("unsupported extension")
- **Transient errors**: no retry on "Request contains an invalid argument" or 429/5xx
- **Research**: ../research/backend-image-format-crop-decoder-gap.md

## Target state

- `--crop` works for all 10 EXT_TO_MIME formats with meaningful error messages on true decode failures
- Read path validates content matches extension (warn or reject mismatch)
- URL input either implemented (download + process) or removed from help text
- Provider calls retry transient errors (429, 5xx, "Request contains an invalid argument") with exponential backoff
- `imagescript` removed from dependencies (sharp covers its use cases: crop, encode, dimension extraction)

## Key technical decisions

| ID | Decision | Rationale |
|---|----------|-----------|
| 1 | Replace `imagescript` with `sharp` for crop/encode/decode | `sharp` supports full EXT_TO_MIME set (png/jpeg/gif/webp/bmp/tiff/avif/ico), no WASM, native speed, maintained |
| 2 | Keep `image-size` for dimension extraction (already used) | `sharp` can also do this, but `image-size` is zero-dep and works; unify if sharp already in tree |
| 3 | Content sniffing: use `sharp` to detect actual format on read | Fail fast on extension/mime mismatch before hitting provider; configurable strictness |
| 4 | URL input: implement download to temp file, then process | Matches user expectation from help text; reuse existing read path |
| 5 | Transient retry: add to `generateWithFallback` for specific error classes | Single retry with backoff is enough; don't over-engineer |

## Deliverables

| # | Deliverable | File(s) |
|---|---|---|
| 1 | Replace `imagescript` dependency with `sharp`; update `safeCropImage`, `encodeCroppedImage`, `cropImage` | `src/core.ts`, `package.json` |
| 2 | Add content-sniffing in `readImageFileWithReason` using `sharp` | `src/core.ts` |
| 3 | Implement URL download helper in `readImageFileWithReason` | `src/core.ts` |
| 4 | Add transient error classification + retry in `generateWithFallback` | `src/commands/analyze.ts` |
| 5 | Update help text if URL not implemented (decision point) | `src/cli.ts` |
| 6 | Unit tests for crop on all 10 formats, content mismatch, URL, transient retry | `src/core.test.ts`, `src/commands/analyze.test.ts` |

## Worktree Strategy

Single worktree (tightly coupled changes across core decode path, read path, provider retry). All deliverables share the `sharp` migration and format-handling layer.

**Track**: `feat/image-format-full-support`
- Branch: `feat/image-format-full-support`
- Area: `backend`
- Tasks:
  1. Add `sharp` to deps, remove `imagescript`
  2. Rewrite `safeCropImage`/`encodeCroppedImage`/`cropImage` using `sharp`
  3. Add `sharp` format detection in `readImageFileWithReason` (content sniff)
  4. Add URL download helper (http/https, follow redirects, size limit)
  5. Classify transient errors in `generateWithFallback`; add retry with backoff
  6. Update help text if URL path dropped
  7. Write tests: crop on all 10 formats; content mismatch; URL; transient retry simulation
- Verification: `vp analyze` with `--crop` on each format; `vp analyze <url>`; `vp config validate` sanity

## Tools / MCP / Skills

- Native tools: Bash, Read, Write, Edit, Grep
- MCP: codebase-memory (trace paths), context7 (sharp API docs)
- Skills: None specific

## Risks / open questions

1. **`sharp` native build** - requires libvips; ensure CI and install docs cover it (already in many environments). Alternative: `sharp` is optional in some projects; we make it required.
2. **WASM vs native** - removing `imagescript` drops WASM path but gains broader format support. Acceptable trade.
3. **Content sniffing strictness** - reject on mismatch or warn? Default to warn + continue for backwards compat; `VP_STRICT_MIME=1` to reject.
4. **URL download size limit** - reuse `VP_MAX_IMAGE_BYTES`; streaming download to avoid buffering >limit.
5. **TIFF in `sharp`** - verify `sharp` handles Pillow-generated TIFF variants (deflate/LZW/packbits/raw). `sharp` uses libvips which supports all common TIFF compressions.