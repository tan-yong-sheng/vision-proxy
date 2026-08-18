---
type: research
title: image-format-crop-decoder-gap
description: Stress-test results for vp image format support showing read path works for all claimed formats but crop path (imagescript) only handles PNG/JPEG; TIFF WASM crash; GIF uses wrong decoder
area: backend
tags: []
status: active
created: "2026-08-18"
updated: "2026-08-18"
sources:
  - local:src/core.ts
  - local:src/commands/analyze.ts
  - local:.local/share/vision-proxy/v0.1.0-rc.2/node_modules/imagescript/ImageScript.js
  - verified-by:vp analyze (10 formats + edge cases)
  - url:https://ai.google.dev/gemini-api/docs/vision
stale_after: "2026-09-17"
related: []
---
# image-format-crop-decoder-gap

## Question

What image formats does the `vp` CLI actually support end-to-end, and where do format handling gaps exist (read path vs crop path vs provider acceptance)?

## Summary of findings

| # | Finding | Relevance | Confidence | Evidence |
|---|---------|-----------|------------|----------|
| 1 | Read path (extension-based base64 encode) works for all 10 claimed formats: png, jpg, jpeg, gif, webp, bmp, tiff, tif, ico, avif | critical | high | verified-by:vp analyze base.<fmt> --api-key invalid --no-fence --json (all exit 1 with "API key not valid" = read succeeded) |
| 2 | End-to-end with Gemini: png, jpg, gif, webp, bmp, ico, avif accepted and described correctly | critical | high | verified-by:vp analyze base.<fmt> --no-fence (10/10 success across 3 runs) |
| 3 | TIFF end-to-end: accepted by Gemini (contrary to docs), works for deflate/LZW/packbits/raw | critical | high | verified-by:vp analyze *.tiff --no-fence (10/10 runs succeeded on re-test) |
| 4 | `--crop` path (imagescript) only decodes PNG/JPEG; GIF/TIFF/WebP/BMP/ICO/AVIF fail with generic "crop failed" | critical | high | verified-by:vp analyze base.<fmt> --crop 0:n=0.25,0.25,0.5,0.5 --api-key invalid --no-fence --json |
| 5 | imagescript GIF decode fails because vp calls `Image.decode()` but GIF requires `GIF.decode()` (separate class) | critical | high | local:src/core.ts:1344 calls Image.decode; local:.local/share/vision-proxy/v0.1.0-rc.2/node_modules/imagescript/ImageScript.js:1458 has GIF.decode |
| 6 | imagescript TIFF decode crashes with WASM "memory access out of bounds" on Pillow-generated TIFFs | critical | high | verified-by:node -e 'Image.decode(Uint8Array(tiff))' (all 4 compressions fail) |
| 7 | URL input is documented but unimplemented; returns "unsupported extension" | normal | high | verified-by:vp analyze "https://..." --api-key invalid --no-fence |
| 8 | Extension/mime mismatch not validated: PNG bytes renamed .avif sent as image/avif; Gemini re-sniffs and accepts | normal | high | verified-by:vp analyze avif-is-png.avif --no-fence |

## Findings

### Read path: extension-based, content-agnostic
`readImageFileWithReason` (src/core.ts:937) looks up `EXT_TO_MIME` by file extension only, reads bytes, base64-encodes, and sends to provider with the extension-derived mime. No content sniffing or format validation occurs. All 10 claimed formats reach the API; unsupported extensions (heic, svg, pdf, empty.bin) are correctly rejected as "unsupported extension". The 10MB size limit (configurable via `VP_MAX_IMAGE_BYTES`) works.

### Crop path: the real bottleneck
`safeCropImage` (src/core.ts:1336) uses `imagescript` `Image.decode()`, which only handles PNG/JPEG/TIFF per its source (ImageScript.js:1090). The separate `GIF` class has its own `decode()` (ImageScript.js:1458) that vp doesn't call. Result:
- PNG/JPEG: crop succeeds
- GIF: "crop failed" (wrong decoder)
- TIFF: "crop failed" (WASM OOM crash)
- WebP/BMP/ICO/AVIF: "crop failed" (unsupported by imagescript)

### TIFF end-to-end: actually works
Initial stress test showed one "Request contains an invalid argument" on TIFF, but 10 subsequent re-runs across 4 compression variants (deflate, LZW, PackBits, raw) all succeeded with valid descriptions. The docs list supported input types as PNG/JPEG/WebP/HEIC/HEIF and file-input as BMP/JPEG/PNG/WebP - TIFF is absent from both lists but works in practice. The failure was a transient provider error, not a format rejection.

### Extension/mime mismatch risk
`vp` trusts the extension. A PNG file named `foo.avif` is sent to the API as `image/avif`. Gemini re-sniffs and accepts; a stricter provider would reject. No client-side validation exists.

### URL input dead code
Help text says `<paths> or URLs` but `mimeTypeForExt("https://...")` returns undefined, yielding "unsupported extension". URL handling is not implemented.

## Open questions

1. Should the crop path use a broader decoder (e.g., sharp) to support the full EXT_TO_MIME set?
2. Should read path add content sniffing to validate extension/mime alignment?
3. Should URL input be implemented or removed from help text?
4. Should vp retry transient provider errors (like the TIFF "invalid argument" that disappeared on retry)?

## Sources

| Source | Type | Notes |
|--------|------|-------|
| src/core.ts | local | EXT_TO_MIME, readImageFileWithReason, safeCropImage, cropImage, applyCrop |
| src/commands/analyze.ts | local | applyCrop, generateWithFallback (no retry on transient) |
| .local/share/vision-proxy/v0.1.0-rc.2/node_modules/imagescript/ImageScript.js | local | Image.decode (PNG/JPEG/TIFF only), GIF.decode (separate class) |
| verified-by:vp analyze (10 formats + edge cases) | command | All stress-test commands and results reproduced above |
| https://ai.google.dev/gemini-api/docs/vision | url | Official Gemini supported image mime types |