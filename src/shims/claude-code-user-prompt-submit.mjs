#!/usr/bin/env node
// fallow-ignore-file unused-file
/**
 * Vision proxy UserPromptSubmit shim for Claude Code.
 *
 * Claude Code invokes this once per user turn, piping the hook event JSON to
 * stdin. We extract image paths from the prompt, shell out to `vp analyze`,
 * and print the fenced description as `additionalContext` so Claude sees it as
 * a system note.
 *
 * Fail-open: on any error (missing vp binary, no API key, timeout) we exit 0
 * with no stdout and a note on stderr, so the agent proceeds unchanged. The
 * hook also enforces its own timeout so it never exhausts the agent's turn.
 *
 * The fenced description is attacker-controlled text, so the fence stays on by
 * default inside `vp analyze`; this shim only forwards it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = Number(process.env.VP_HOOK_TIMEOUT_MS ?? 30000);
const IMAGE_EXT = "jpg|jpeg|png|gif|webp|bmp|tiff|tif|ico|avif";

/** Extract candidate image file paths from prompt text (no whitespace inside paths). */
function extractImagePaths(text) {
	const paths = new Set();
	const add = (p) => {
		p = (p || "").trim();
		if (p) paths.add(p);
	};
	// Pass 1: pi-clipboard temp files.
	const re1 = /(?:^|[\s"'])([a-zA-Z]:[/\\][^\s"'*?|]*?pi-clipboard-[a-f0-9-]+\.[a-zA-Z0-9]+|\/[^\s"'*?|]*?pi-clipboard-[a-f0-9-]+\.[a-zA-Z0-9]+)/gim;
	for (const m of text.matchAll(re1)) add(m[1]);
	// Pass 2: general image paths with a recognized prefix (filter bare filenames).
	const re2 = new RegExp(
		`(?:^|[\\s"'(])((?:[a-zA-Z]:[/\\\\]|/|~)[\\w./\\\\+-]*[/\\\\][\\w.+-]+\\.(?:${IMAGE_EXT}))\\b`,
		"gi",
	);
	for (const m of text.matchAll(re2)) add(m[1]);
	// Pass 3: relative ./ and ../ paths.
	const re3 = new RegExp(
		`(?:^|[\\s"'(])(\\.\\.?/[\\w./\\\\+-]+\\.(?:${IMAGE_EXT}))\\b`,
		"gi",
	);
	for (const m of text.matchAll(re3)) add(m[1]);
	return [...paths];
}

function failOpen(reason) {
	if (reason) process.stderr.write(`[vision-proxy] ${reason}\n`);
}

function main() {
	let raw = "";
	try {
		raw = readFileSync(0, "utf8");
	} catch {
		return failOpen("could not read hook event from stdin");
	}
	let event;
	try {
		event = JSON.parse(raw);
	} catch {
		return failOpen("hook event on stdin was not valid JSON");
	}
	const prompt = typeof event.prompt === "string" ? event.prompt : "";
	const images = extractImagePaths(prompt);
	if (images.length === 0) return; // No images: proceed unchanged.

	const vp = process.env.VP_BIN || "vp";
	const result = spawnSync(vp, ["analyze", ...images], {
		encoding: "utf8",
		timeout: TIMEOUT_MS,
		maxBuffer: 10 * 1024 * 1024,
	});
	if (result.error) {
		// ENOENT (vp missing) or the spawned process was killed on timeout.
		if (result.error.code === "ENOENT") return failOpen(`vp binary not found: ${vp}`);
		return failOpen("vp analyze failed or timed out");
	}
	if (result.status !== 0 || !result.stdout.trim()) {
		return failOpen(`vp analyze exited with status ${result.status ?? "?"}`);
	}
	const description = result.stdout.trimEnd();
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: description,
			},
		}) + "\n",
	);
}

main();
