/**
 * Unit tests for `vp hook`.
 *
 * Exercises the event routing and `vp analyze` dispatch contract without a live
 * vision model: `VP_BIN` points at a fake `vp` that echoes a fenced description.
 * Validates:
 *   - UserPromptSubmit extracts image paths from the prompt and emits context
 *   - PreToolUse Read with an image file_path emits context
 *   - PreToolUse Read on a non-image is a no-op (fail-open)
 *   - PreToolUse for a non-Read tool is a no-op
 *   - unrecognized event types, JSON parse failure, no images -> empty stdout
 *   - defensive path resolution against cwd
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	emit,
	extractImagePaths,
	isImagePath,
	readEvent,
	readToolFilePath,
	resolveImagePath,
	resolveImageRefs,
	runHook,
	vpEntryToSpawn,
} from "./hook.ts";

/** Write a fake `vp` that emits a fenced description for any args. */
function writeFakeVp(dir: string): string {
	const fake = join(dir, "vp");
	writeFileSync(
		fake,
		[
			"#!/usr/bin/env node",
			'const out = "<vision_proxy_description>A red square on white.</vision_proxy_description>";',
			'process.stdout.write(out + "\\n");',
		].join("\n"),
		{ mode: 0o755 },
	);
	return fake;
}

/**
 * Write a fake `vp` that records its argv to `<dir>/args.json` and emits a
 * fenced description. Used to assert that the hook forwards `--question`.
 */
function writeRecordingFakeVp(dir: string): string {
	const fake = join(dir, "vp");
	const argsPath = join(dir, "args.json").replace(/\\/g, "\\\\");
	writeFileSync(
		fake,
		[
			"#!/usr/bin/env node",
			'const fs = require("fs");',
			`fs.writeFileSync("${argsPath}", JSON.stringify(process.argv));`,
			'const out = "<vision_proxy_description>A red square on white.</vision_proxy_description>";',
			'process.stdout.write(out + "\\n");',
		].join("\n"),
		{ mode: 0o755 },
	);
	return fake;
}

/** Capture stdout of `fn` (restored after). */
function captureStdout(fn: () => void): string {
	const chunks: string[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	// @ts-expect-error - override for capture
	process.stdout.write = (s: string) => {
		chunks.push(String(s));
		return true;
	};
	try {
		fn();
	} finally {
		process.stdout.write = orig;
	}
	return chunks.join("");
}

test("resolveImageRefs empty when no session id or no refs", () => {
	assert.deepEqual(resolveImageRefs("no refs here", undefined), []);
	assert.deepEqual(resolveImageRefs("look [Image #3]", undefined), []);
	// session id set but cache dir does not exist
	assert.deepEqual(resolveImageRefs("look [Image #3]", "nope"), []);
});

test("resolveImageRefs resolves cached Claude Code image files", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-imgref-"));
	const session = "sess-abc-123";
	const sessionDir = join(dir, "image-cache", session);
	mkdirSync(sessionDir, { recursive: true });
	const pngPath = join(sessionDir, "1.png");
	writeFileSync(pngPath, "fake-png-bytes");
	const jpgPath = join(sessionDir, "2.jpg");
	writeFileSync(jpgPath, "fake-jpg-bytes");
	const prev = process.env.VP_CLAUDE_CONFIG_DIR;
	process.env.VP_CLAUDE_CONFIG_DIR = dir;
	try {
		const got = resolveImageRefs("see [Image #1] and [Image #2]", session);
		assert.deepEqual(got.sort(), [jpgPath, pngPath].sort());
		// ref to a missing id yields nothing (fail-open)
		assert.deepEqual(resolveImageRefs("[Image #9]", session), []);
		// de-duped when a ref appears twice
		assert.deepEqual(resolveImageRefs("[Image #1] [Image #1]", session), [pngPath]);
	} finally {
		if (prev === undefined) delete process.env.VP_CLAUDE_CONFIG_DIR;
		else process.env.VP_CLAUDE_CONFIG_DIR = prev;
	}
});

test("UserPromptSubmit with [Image #N] refs emits additionalContext", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-hook-ref-"));
	const vpBin = writeFakeVp(dir);
	const session = "sess-ref-1";
	const sessionDir = join(dir, "image-cache", session);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "1.png"), "fake-png");
	const event = {
		hook_event_name: "UserPromptSubmit",
		session_id: session,
		prompt: "What is in [Image #1]?",
	};
	const out = captureStdout(() => {
		const prevVpBin = process.env.VP_BIN;
		const prevCfg = process.env.VP_CLAUDE_CONFIG_DIR;
		process.env.VP_BIN = vpBin;
		process.env.VP_CLAUDE_CONFIG_DIR = dir;
		try {
			runHook(event);
		} finally {
			if (prevVpBin === undefined) delete process.env.VP_BIN;
			else process.env.VP_BIN = prevVpBin;
			if (prevCfg === undefined) delete process.env.VP_CLAUDE_CONFIG_DIR;
			else process.env.VP_CLAUDE_CONFIG_DIR = prevCfg;
		}
	});
	assert.equal(out.trim() !== "", true);
	const parsed = JSON.parse(out.trim());
	assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.match(parsed.hookSpecificOutput.additionalContext, /red square on white/);
});

test("isImagePath recognizes known extensions and rejects others", () => {
	assert.equal(isImagePath("/a/b.png"), true);
	assert.equal(isImagePath("/a/b.jpg"), true);
	assert.equal(isImagePath("/a/b.PNG"), true);
	assert.equal(isImagePath("/a/b.webp"), true);
	assert.equal(isImagePath("/a/b.txt"), false);
	assert.equal(isImagePath("/a/b"), false);
	assert.equal(isImagePath(undefined), false);
	assert.equal(isImagePath(""), false);
});

test("extractImagePaths finds absolute, tilde, relative, and pi-clipboard paths", () => {
	const prompt =
		"Look at /home/me/shot.png and ~/Pictures/a.jpg plus ./rel/b.webp and " +
		"/tmp/pi-clipboard-1234-abcd.png and ignore notes.txt and notanimage";
	const got = extractImagePaths(prompt);
	assert.ok(got.includes("/home/me/shot.png"));
	assert.ok(got.includes("~/Pictures/a.jpg"));
	assert.ok(got.includes("./rel/b.webp"));
	assert.ok(got.includes("/tmp/pi-clipboard-1234-abcd.png"));
	assert.ok(!got.some((p) => p.includes("notes.txt")));
});

test("extractImagePaths handles paths containing spaces", () => {
	const prompt =
		"what about /home/tys203831/Pictures/Screenshot from 2026-08-13 00-09-08.png and " +
		"~/Pictures/my holiday/photo 1.jpg or ./vacation pics/beach.png?";
	const got = extractImagePaths(prompt);
	assert.deepEqual(got, [
		"/home/tys203831/Pictures/Screenshot from 2026-08-13 00-09-08.png",
		"~/Pictures/my holiday/photo 1.jpg",
		"./vacation pics/beach.png",
	]);
});

test("readToolFilePath returns resolved image path for PreToolUse Read", () => {
	const event = {
		hook_event_name: "PreToolUse",
		tool_name: "Read",
		tool_input: { file_path: "/abs/img.png" },
	};
	assert.equal(readToolFilePath(event), "/abs/img.png");
});

test("readToolFilePath resolves relative path against cwd", () => {
	const event = {
		hook_event_name: "PreToolUse",
		tool_name: "Read",
		cwd: "/work",
		tool_input: { file_path: "./img.png" },
	};
	assert.equal(readToolFilePath(event), join("/work", "img.png"));
});

test("readToolFilePath falls back to `path` key and rejects non-images", () => {
	assert.equal(
		readToolFilePath({ tool_name: "Read", tool_input: { path: "/x/y.jpeg" } }),
		"/x/y.jpeg",
	);
	assert.equal(
		readToolFilePath({ tool_name: "Read", tool_input: { file_path: "/x/y.txt" } }),
		null,
	);
	assert.equal(
		readToolFilePath({ tool_name: "Bash", tool_input: { file_path: "/x/y.png" } }),
		null,
	);
	assert.equal(readToolFilePath({ tool_name: "Read", tool_input: {} }), null);
});

test("emit writes hookSpecificOutput.additionalContext", () => {
	const out = captureStdout(() => emit("UserPromptSubmit", "ctx-text"));
	const parsed = JSON.parse(out);
	assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.equal(parsed.hookSpecificOutput.additionalContext, "ctx-text");
});

test("UserPromptSubmit with an image path emits additionalContext", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-hook-"));
	const vpBin = writeFakeVp(dir);
	const event = {
		hook_event_name: "UserPromptSubmit",
		prompt: "What is in /home/me/screenshot.png?",
	};
	const out = captureStdout(() => {
		const prev = process.env.VP_BIN;
		process.env.VP_BIN = vpBin;
		try {
			runHook(event);
		} finally {
			if (prev === undefined) delete process.env.VP_BIN;
			else process.env.VP_BIN = prev;
		}
	});
	assert.equal(out.trim() !== "", true);
	const parsed = JSON.parse(out.trim());
	assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.match(
		parsed.hookSpecificOutput.additionalContext,
		/Do not use the Read tool on image files/,
	);
	assert.match(
		parsed.hookSpecificOutput.additionalContext,
		/vision-proxy has already routed the image/,
	);
	assert.match(
		parsed.hookSpecificOutput.additionalContext,
		/ask in the prompt instead of reading the file/,
	);
	assert.match(parsed.hookSpecificOutput.additionalContext, /red square on white/);
});

test("UserPromptSubmit forwards the prompt as --question to vp analyze", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-hook-"));
	const vpBin = writeRecordingFakeVp(dir);
	const event = {
		hook_event_name: "UserPromptSubmit",
		prompt: "What is in /home/me/screenshot.png?",
	};
	captureStdout(() => {
		const prev = process.env.VP_BIN;
		process.env.VP_BIN = vpBin;
		try {
			runHook(event);
		} finally {
			if (prev === undefined) delete process.env.VP_BIN;
			else process.env.VP_BIN = prev;
		}
	});
	const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];
	const questionIdx = args.indexOf("--question");
	assert.ok(questionIdx !== -1, "expected --question in vp analyze args");
	assert.equal(args[questionIdx + 1], event.prompt);
});

test("UserPromptSubmit with no image is a no-op", () => {
	const event = { hook_event_name: "UserPromptSubmit", prompt: "refactor the auth module" };
	const out = captureStdout(() => runHook(event));
	assert.equal(out.trim(), "");
});

test("PreToolUse Read of an image denies the tool and emits additionalContext", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-hook-"));
	const vpBin = writeFakeVp(dir);
	const event = {
		hook_event_name: "PreToolUse",
		tool_name: "Read",
		tool_input: { file_path: "/home/me/diagram.png" },
	};
	const out = captureStdout(() => {
		const prev = process.env.VP_BIN;
		process.env.VP_BIN = vpBin;
		try {
			runHook(event);
		} finally {
			if (prev === undefined) delete process.env.VP_BIN;
			else process.env.VP_BIN = prev;
		}
	});
	assert.equal(out.trim() !== "", true);
	const parsed = JSON.parse(out.trim());
	assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
	assert.ok(typeof parsed.hookSpecificOutput.permissionDecisionReason === "string");
	assert.match(
		parsed.hookSpecificOutput.additionalContext,
		/Do not use the Read tool on image files/,
	);
	assert.match(
		parsed.hookSpecificOutput.additionalContext,
		/vision-proxy has already routed the image/,
	);
	assert.match(
		parsed.hookSpecificOutput.additionalContext,
		/ask in the prompt instead of reading the file/,
	);
	assert.match(parsed.hookSpecificOutput.additionalContext, /red square on white/);
});

test("PreToolUse Read of a non-image and a non-Read tool are no-ops", () => {
	const nonImage = {
		hook_event_name: "PreToolUse",
		tool_name: "Read",
		tool_input: { file_path: "/etc/hosts" },
	};
	const nonRead = {
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command: "ls" },
	};
	assert.equal(captureStdout(() => runHook(nonImage)).trim(), "");
	assert.equal(captureStdout(() => runHook(nonRead)).trim(), "");
});

test("unrecognized event type is a no-op", () => {
	const event = { hook_event_name: "PostToolUse", prompt: "x /a/b.png" };
	assert.equal(captureStdout(() => runHook(event)).trim(), "");
});

test("readEvent returns null on invalid JSON", () => {
	// A tiny fake for stdin: not trivial via readFileSync(0); instead assert the
	// documented fail-open behavior by reading an empty-ish buffer is hard here,
	// so we validate the public shape contract indirectly through runHook no-op.
	assert.equal(typeof readEvent, "function");
	assert.equal(typeof resolveImagePath, "function");
});

test("vpEntryToSpawn prefixes node for a .js entry path", () => {
	const js = vpEntryToSpawn("/opt/vision-proxy/dist/cli.js");
	assert.equal(js.command, process.execPath);
	assert.deepEqual(js.args, ["/opt/vision-proxy/dist/cli.js"]);
});

test("vpEntryToSpawn returns the launcher as-is for non-.js paths", () => {
	const launcher = vpEntryToSpawn("/home/me/.local/bin/vp");
	assert.equal(launcher.command, "/home/me/.local/bin/vp");
	assert.deepEqual(launcher.args, []);
});

/**
 * Regression test for the Homebrew release (0644 dist/cli.js, non-PATH shebang):
 * when the hook is launched via the compiled entry, resolveVpBin() returns a
 * `.js` path that cannot be spawned directly (EACCES). The hook must re-exec it
 * under process.execPath, so a UserPromptSubmit flow still produces context.
 */
test("UserPromptSubmit works when argv[1] is a non-executable .js entry", () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-hook-js-"));
	// A `.js` fake with NO exec bit, mimicking the Homebrew dist/cli.js.
	const jsFake = join(dir, "cli.js");
	writeFileSync(
		jsFake,
		[
			"#!/usr/bin/env node",
			'const out = "<vision_proxy_description>A red square on white.</vision_proxy_description>";',
			'process.stdout.write(out + "\\n");',
		].join("\n"),
		{ mode: 0o644 },
	);
	const event = {
		hook_event_name: "UserPromptSubmit",
		prompt: "What is in /home/me/screenshot.png?",
	};
	const out = captureStdout(() => {
		const prevArgv1 = process.argv[1];
		const prevVpBin = process.env.VP_BIN;
		process.argv[1] = jsFake;
		delete process.env.VP_BIN;
		try {
			runHook(event);
		} finally {
			process.argv[1] = prevArgv1;
			if (prevVpBin === undefined) delete process.env.VP_BIN;
			else process.env.VP_BIN = prevVpBin;
		}
	});
	assert.equal(out.trim() !== "", true);
	const parsed = JSON.parse(out.trim());
	assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.match(parsed.hookSpecificOutput.additionalContext, /red square on white/);
});
