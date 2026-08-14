// fallow-ignore-file unused-file
#!/usr/bin/env node
/**
 * Vision proxy UserPromptSubmit shim for the Codex CLI.
 *
 * Codex fires this hook on every user prompt, piping the event JSON to stdin.
 * We extract image paths from the prompt, shell out to `vp analyze` (capped at
 * Codex's default ~2500-token preview limit), and print the fenced description
 * as `hookSpecificOutput.additionalContext`.
 *
 * Codex caps model-visible hook output at roughly 2500 tokens by default; larger
 * output is spilled to disk and only a preview is shown. So the CLI is asked to
 * cap output at 2000 tokens unless overridden via VP_MAX_OUTPUT_TOKENS. The hook
 * also enforces its own timeout so it never exhausts the agent's turn.
 *
 * Fail-open: on any error we exit 0 with no stdout and a note on stderr, so the
 * agent proceeds unchanged. The description is attacker-controlled text, so the
 * fence stays on inside `vp analyze`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = Number(process.env.VP_HOOK_TIMEOUT_MS ?? 30000);
// Codex shows ~2500 tokens by default; stay under the preview limit.
const MAX_OUTPUT_TOKENS = Number(process.env.VP_MAX_OUTPUT_TOKENS ?? 2000);
const IMAGE_EXT = "jpg|jpeg|png|gif|webp|bmp|tiff|tif|ico|avif";

/** Extract candidate image file paths from prompt text (no whitespace inside paths). */
function extractImagePaths(text) {
	const paths = new Set();
	const add = (p) => {
		p = (p || "").trim();
		if (p) paths.add(p);
	};
	const re1 = /(?:^|[\s"'])([a-zA-Z]:[/\\][^\s"'*?|]*?pi-clipboard-[a-f0-9-]+\.[a-zA-Z0-9]+|\/[^\s"'*?|]*?pi-clipboard-[a-f0-9-]+\.[a-zA-Z0-9]+)/gim;
	for (const m of text.matchAll(re1)) add(m[1]);
	const re2 = new RegExp(
		`(?:^|[\\s"'(])((?:[a-zA-Z]:[/\\\\]|/|~)[\\w./\\\\+-]*[/\\\\][\\w.+-]+\\.(?:${IMAGE_EXT}))\\b`,
		"gi",
	);
	for (const m of text.matchAll(re2)) add(m[1]);
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
	const result = spawnSync(
		vp,
		["analyze", ...images, "--max-output-tokens", String(MAX_OUTPUT_TOKENS)],
		{
			encoding: "utf8",
			timeout: TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
		},
	);
	if (result.error) {
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
