/**
 * End-to-end test for the vision-proxy Claude Code UserPromptSubmit hook.
 *
 * Exercises a real image path through the shim exactly as Claude Code would:
 *   - A UserPromptSubmit event JSON (with a real image path in the prompt) is
 *     piped to the shim's stdin.
 *   - The shim extracts the image path, shells out to `vp analyze`, and prints
 *     a Claude Code hook output JSON whose `hookSpecificOutput.additionalContext`
 *     carries the fenced description.
 *
 * To avoid requiring a live vision API key, we point VP_BIN at a fake `vp` that
 * echoes a fenced <vision_proxy_description> block for any image. This validates
 * the routing + output contract, which is what the hook owns.
 *
 * Run: node --test src/shims/claude-code-hook.e2e.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const shimPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"shims",
	"claude-code-user-prompt-submit.mjs",
);

/** Write a fake `vp` that emits a fenced description for any args. */
function writeFakeVp(dir) {
	const fake = join(dir, "vp");
	writeFileSync(
		fake,
		[
			"#!/usr/bin/env node",
			'const out = "<vision_proxy_description image=\\"test.png\\">A red square on white.</vision_proxy_description>";',
			'process.stdout.write(out + "\\n");',
		].join("\n"),
		{ mode: 0o755 },
	);
	return fake;
}

function runShim(dir, eventJson, vpBin) {
	const env = { ...process.env, VP_BIN: vpBin, VP_HOOK_TIMEOUT_MS: "10000" };
	return spawnSync("node", [shimPath], {
		input: eventJson,
		encoding: "utf8",
		env,
	});
}

test("no images in prompt -> empty stdout, exit 0 (fail-open passthrough)", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-e2e-"));
	const vpBin = writeFakeVp(dir);
	const event = JSON.stringify({ prompt: "refactor the auth module" });
	const r = runShim(dir, event, vpBin);
	assert.equal(r.status, 0);
	assert.equal(r.stdout.trim(), "");
});

test("real image path -> fenced description lands as additionalContext", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-e2e-"));
	const vpBin = writeFakeVp(dir);
	// A genuine image file on disk so the path is "real".
	const imgPath = join(dir, "screenshot.png");
	writeFileSync(imgPath, Buffer.from("fake-png-bytes"));
	const event = JSON.stringify({
		prompt: `What does this show: ${imgPath}?`,
		session_id: "abc",
		source: "user",
	});
	const r = runShim(dir, event, vpBin);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	const parsed = JSON.parse(r.stdout.trim());
	assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	const ctx = parsed.hookSpecificOutput.additionalContext;
	assert.ok(ctx.includes("<vision_proxy_description"), "fence must be present");
	assert.ok(ctx.includes("A red square on white."), "description text must be present");
	assert.ok(ctx.includes(imgPath) === false, "raw path should have been stripped/isolated");
});

test("missing vp binary -> fail open (exit 0, no stdout)", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-e2e-"));
	const imgPath = join(dir, "x.png");
	writeFileSync(imgPath, Buffer.from("x"));
	const event = JSON.stringify({ prompt: `look ${imgPath}` });
	const r = runShim(dir, event, join(dir, "does-not-exist-vp"));
	assert.equal(r.status, 0);
	assert.equal(r.stdout.trim(), "");
	assert.match(r.stderr, /vp binary not found/);
});
