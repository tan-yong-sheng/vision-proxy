/**
 * Shared helpers for the vision-proxy UserPromptSubmit hook shims.
 *
 * Kept as plain `.mjs` with no dependencies so an installed shim can run under
 * bare `node` next to the `vp` binary. `scripts/copy-shims.mjs` copies this file
 * into `dist/shims/`, and `vp integration install claude-code|codex` copies it next to the installed shim,
 * rewriting `__VP_PATH__PLACEHOLDER__` with the absolute `vp` binary path at install time.
 *
 * Fail-open convention: `readEvent` and `runVP` write their own stderr note and
 * return `undefined` on failure, so a caller only has to bail on a falsy result.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const IMAGE_EXT = "jpg|jpeg|png|gif|webp|bmp|tiff|tif|ico|avif";
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Extract candidate image file paths from prompt text (no whitespace inside paths). */
export function extractImagePaths(text) {
	const paths = new Set();
	const add = (p) => {
		p = (p || "").trim();
		if (p) paths.add(p);
	};
	// Pass 1: pi-clipboard temp files.
	const re1 =
		/(?:^|[\s"'])([a-zA-Z]:[/\\][^\s"'*?|]*?pi-clipboard-[a-f0-9-]+\.[a-zA-Z0-9]+|\/[^\s"'*?|]*?pi-clipboard-[a-f0-9-]+\.[a-zA-Z0-9]+)/gim;
	for (const m of text.matchAll(re1)) add(m[1]);
	// Pass 2: general image paths with a recognized prefix (filter bare filenames).
	const re2 = new RegExp(
		`(?:^|[\\s"'(])((?:[a-zA-Z]:[/\\\\]|/|~)[\\w./\\\\+-]*[/\\\\][\\w.+-]+\\.(?:${IMAGE_EXT}))\\b`,
		"gi",
	);
	for (const m of text.matchAll(re2)) add(m[1]);
	// Pass 3: relative ./ and ../ paths.
	const re3 = new RegExp(`(?:^|[\\s"'(])(\\.\\.?/[\\w./\\\\+-]+\\.(?:${IMAGE_EXT}))\\b`, "gi");
	for (const m of text.matchAll(re3)) add(m[1]);
	return [...paths];
}

/** Note the reason on stderr and return undefined so the agent proceeds unchanged. */
export function failOpen(reason) {
	if (reason) process.stderr.write(`[vision-proxy] ${reason}\n`);
}

/** Read and parse the hook event JSON from stdin. */
export function readEvent() {
	let raw;
	try {
		raw = readFileSync(0, "utf8");
	} catch {
		return failOpen("could not read hook event from stdin");
	}
	try {
		return JSON.parse(raw);
	} catch {
		return failOpen("hook event on stdin was not valid JSON");
	}
}

/**
 * Path to the `vp` binary, rewritten by `vp integration install` to an absolute
 * path at install time. The sentinel `"__VP_PATH__PLACEHOLDER__"` means it was
 * left intact (dev / unset), in which case we fall back to `vp` on PATH.
 */
const VP_BIN_PATH = "__VP_PATH__PLACEHOLDER__";
const VP_PATH_SENTINEL = "__VP_PATH__PLACEHOLDER__";

/** Run `vp analyze <images> [extraArgs]` and return the fenced description. */
export function runVP(images, extraArgs = []) {
	// VP_BIN wins (test override / explicit path). Otherwise prefer the
	// install-time absolute path; fall back to `vp` on PATH if unset.
	const vp = process.env.VP_BIN || (VP_BIN_PATH === VP_PATH_SENTINEL ? "vp" : VP_BIN_PATH);
	const result = spawnSync(vp, ["analyze", ...images, ...extraArgs], {
		encoding: "utf8",
		timeout: Number(process.env.VP_HOOK_TIMEOUT_MS ?? 30000),
		maxBuffer: MAX_BUFFER_BYTES,
	});
	if (result.error) {
		// ENOENT (vp missing) or the spawned process was killed on timeout.
		if (result.error.code === "ENOENT") return failOpen(`vp binary not found: ${vp}`);
		return failOpen("vp analyze failed or timed out");
	}
	if (result.status !== 0 || !result.stdout.trim()) {
		return failOpen(`vp analyze exited with status ${result.status ?? "?"}`);
	}
	return result.stdout.trimEnd();
}

/** Write the UserPromptSubmit hook output JSON that Claude Code and Codex both accept. */
export function emit(description) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: description,
			},
		}) + "\n",
	);
}

/**
 * Shared hook main loop.
 *
 * Reads the event, extracts image paths from the prompt, shells out to `vp
 * analyze`, and emits the description. Returns early (fail-open) on any error
 * or when no images are found.
 */
export function runShim(extraArgs = []) {
	const event = readEvent();
	if (!event) return;
	const prompt = typeof event.prompt === "string" ? event.prompt : "";
	const images = extractImagePaths(prompt);
	if (images.length === 0) return; // No images: proceed unchanged.

	const description = runVP(images, extraArgs);
	if (!description) return;
	emit(description);
}
