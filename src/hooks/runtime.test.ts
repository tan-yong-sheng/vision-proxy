/**
 * Unit tests for the canonical standalone hook runtime (`runtime.ts`).
 *
 * Covers the shared analysis policy inlined into every generated host
 * artifact: path classification, tilde/HOME resolution, image path
 * extraction edge cases, env parsing fallbacks, vp command resolution,
 * analyze argument construction, and reminder/instruction rendering. Exact
 * wording assertions pin the historical host phrasing so unification cannot
 * silently reword what hosts key on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildAnalyzeArgs,
	extractImagePaths,
	HOOK_RUNTIME_SOURCE,
	hookTimeoutMs,
	isImagePath,
	maxOutputTokens,
	parsePositiveInt,
	readReminder,
	resolveImagePath,
	resolveVpBin,
	vpEntryToSpawn,
	withImageInstruction,
} from "./runtime.ts";

test("isImagePath matches the shared extension list case-insensitively", () => {
	assert.equal(isImagePath("/tmp/photo.png"), true);
	assert.equal(isImagePath("/tmp/PHOTO.JPG"), true);
	assert.equal(isImagePath("C:\\shots\\cap.Avif"), true);
	assert.equal(isImagePath("/tmp/notes.txt"), false);
	assert.equal(isImagePath("/tmp/noext"), false);
	assert.equal(isImagePath(""), false);
	assert.equal(isImagePath(undefined), false);
	assert.equal(isImagePath(42), false);
});

test("resolveImagePath passes through absolute and drive-letter paths", () => {
	assert.equal(resolveImagePath("/a/b.png"), "/a/b.png");
	assert.equal(resolveImagePath("C:/shots/cap.png"), "C:/shots/cap.png");
	assert.equal(resolveImagePath("d:\\shots\\cap.png"), "d:\\shots\\cap.png");
	assert.equal(resolveImagePath(null), null);
	assert.equal(resolveImagePath(undefined), null);
	assert.equal(resolveImagePath(""), null);
});

test("resolveImagePath expands a leading tilde against HOME first", () => {
	const prior = process.env.HOME;
	process.env.HOME = "/test/home";
	try {
		assert.equal(resolveImagePath("~/sub/photo.png"), "/test/home/sub/photo.png");
		assert.equal(typeof resolveImagePath("~"), "string");
		// "~otheruser" is not portable; it must be left untouched.
		assert.equal(resolveImagePath("~other/photo.png"), "~other/photo.png");
	} finally {
		if (prior === undefined) delete process.env.HOME;
		else process.env.HOME = prior;
	}
});

test("resolveImagePath resolves ./ and ../ against cwd, leaves bare relatives alone", () => {
	assert.equal(resolveImagePath("./pic.png", "/work/dir"), "/work/dir/pic.png");
	assert.equal(resolveImagePath("../pic.png", "/work/dir"), "/work/pic.png");
	assert.equal(resolveImagePath("pic.png", "/work/dir"), "pic.png");
	assert.equal(resolveImagePath("./pic.png"), "./pic.png");
});

test("extractImagePaths finds absolute, tilde, drive, and relative paths", () => {
	assert.deepEqual(extractImagePaths("see /tmp/photo.png please"), ["/tmp/photo.png"]);
	assert.deepEqual(extractImagePaths("see ~/shots/cap.JPG ok"), ["~/shots/cap.JPG"]);
	assert.deepEqual(extractImagePaths("open C:/shots/cap.png now"), ["C:/shots/cap.png"]);
	assert.deepEqual(extractImagePaths("read ./assets/diagram.webp!"), ["./assets/diagram.webp"]);
	assert.deepEqual(extractImagePaths("read ../shared/icon.ico?"), ["../shared/icon.ico"]);
});

test("extractImagePaths matches clipboard temp files with no special case", () => {
	assert.deepEqual(extractImagePaths("paste /tmp/pi-clipboard-abc-123.png here"), [
		"/tmp/pi-clipboard-abc-123.png",
	]);
});

test("extractImagePaths preserves spaces in absolute and relative paths", () => {
	assert.deepEqual(
		extractImagePaths("inspect /tmp/my screenshots/diagram.png and ./assets/my image.webp"),
		["/tmp/my screenshots/diagram.png", "./assets/my image.webp"],
	);
});

test("extractImagePaths finds an image after a preceding non-image path", () => {
	const paths = extractImagePaths("compare /tmp/notes.txt with /tmp/diagram.png");
	assert.ok(paths.includes("/tmp/diagram.png"));
});

test("extractImagePaths trims prose punctuation, rejects URLs, dedupes", () => {
	assert.deepEqual(extractImagePaths("look at /tmp/a.png, then /tmp/a.png."), ["/tmp/a.png"]);
	assert.deepEqual(extractImagePaths("see (/tmp/a.png);"), ["/tmp/a.png"]);
	assert.deepEqual(extractImagePaths("open https://example.com/a.png now"), []);
	assert.deepEqual(extractImagePaths("the nota/path.jpeg word must not match"), []);
	assert.deepEqual(extractImagePaths("plain text, no images"), []);
});

test("extractImagePaths splits on bracket, comma, and semicolon delimiters", () => {
	assert.deepEqual(extractImagePaths("see [/tmp/a.png] now"), ["/tmp/a.png"]);
	assert.deepEqual(extractImagePaths("see /tmp/a.png,/tmp/b.png"), ["/tmp/a.png", "/tmp/b.png"]);
	assert.deepEqual(extractImagePaths("see /tmp/a.png;/tmp/b.png"), ["/tmp/a.png", "/tmp/b.png"]);
	assert.deepEqual(extractImagePaths("read [./assets/diagram.webp]!"), ["./assets/diagram.webp"]);
});

test("extractImagePaths matches extensions case-insensitively", () => {
	assert.deepEqual(extractImagePaths("see /tmp/PHOTO.PNG"), ["/tmp/PHOTO.PNG"]);
});

test("parsePositiveInt falls back on missing, garbage, and out-of-range input", () => {
	assert.equal(parsePositiveInt(undefined, 30, 1, 600), 30);
	assert.equal(parsePositiveInt("not-a-number", 30, 1, 600), 30);
	assert.equal(parsePositiveInt("", 30, 1, 600), 30);
	assert.equal(parsePositiveInt("0", 30, 1, 600), 30);
	assert.equal(parsePositiveInt("601", 30, 1, 600), 30);
	assert.equal(parsePositiveInt("250", 30, 1, 600), 250);
	assert.equal(parsePositiveInt(1, 30, 1, 600), 1);
	assert.equal(parsePositiveInt(600, 30, 1, 600), 600);
});

test("hookTimeoutMs and maxOutputTokens share the documented ranges", () => {
	assert.equal(hookTimeoutMs(undefined), 30000);
	assert.equal(hookTimeoutMs("not-a-number"), 30000);
	assert.equal(hookTimeoutMs("500"), 30000);
	assert.equal(hookTimeoutMs("600001"), 30000);
	assert.equal(hookTimeoutMs("5000"), 5000);
	assert.equal(maxOutputTokens(undefined), 2000);
	assert.equal(maxOutputTokens("also-bogus"), 2000);
	assert.equal(maxOutputTokens("0"), 2000);
	assert.equal(maxOutputTokens("4096"), 4096);
});

test("resolveVpBin honors VP_BIN and defaults to vp", () => {
	const prior = process.env.VP_BIN;
	try {
		delete process.env.VP_BIN;
		assert.equal(resolveVpBin(), "vp");
		process.env.VP_BIN = "  ";
		assert.equal(resolveVpBin(), "vp");
		process.env.VP_BIN = "/opt/vp/bin/vp";
		assert.equal(resolveVpBin(), "/opt/vp/bin/vp");
		process.env.VP_BIN = "  /opt/vp/bin/vp  ";
		assert.equal(resolveVpBin(), "/opt/vp/bin/vp");
	} finally {
		if (prior === undefined) delete process.env.VP_BIN;
		else process.env.VP_BIN = prior;
	}
});

test("vpEntryToSpawn routes .js entries through Node outside Bun", () => {
	assert.deepEqual(vpEntryToSpawn("vp"), { command: "vp", args: [] });
	const routed = vpEntryToSpawn("/opt/vp/dist/cli.js");
	assert.equal(routed.command, process.execPath);
	assert.deepEqual(routed.args, ["/opt/vp/dist/cli.js"]);
});

test("vpEntryToSpawn uses the node launcher when hosted by Bun", () => {
	Object.defineProperty(process.versions, "bun", {
		configurable: true,
		value: "test-bun",
	});
	try {
		assert.deepEqual(vpEntryToSpawn("/opt/vp/dist/cli.js"), {
			command: "node",
			args: ["/opt/vp/dist/cli.js"],
		});
	} finally {
		delete (process.versions as Record<string, unknown>).bun;
	}
});

test("buildAnalyzeArgs shares one analyze contract for every executor", () => {
	const prior = process.env.VP_BIN;
	try {
		delete process.env.VP_BIN;
		const invocation = buildAnalyzeArgs(["/tmp/a.png", "/tmp/b.png"], 2000);
		assert.equal(invocation.command, "vp");
		assert.deepEqual(invocation.args, [
			"analyze",
			"/tmp/a.png",
			"/tmp/b.png",
			"--max-output-tokens",
			"2000",
		]);
	} finally {
		if (prior === undefined) delete process.env.VP_BIN;
		else process.env.VP_BIN = prior;
	}
});

test("withImageInstruction keeps the historical deny wording", () => {
	assert.equal(
		withImageInstruction("DESC", undefined),
		"Do not use the Read tool on image files. " +
			"vision-proxy has already routed the image(s) through a vision-input model " +
			"and produced the description below. " +
			"Treat that description as the image content. " +
			"If you need a more specific or detailed analysis, ask in the prompt instead of reading the file.\n\n" +
			"DESC",
	);
	assert.ok(
		withImageInstruction("DESC", "[vision-proxy:read-reminder]").startsWith(
			"[vision-proxy:read-reminder] Do not use the Read tool on image files. ",
		),
	);
});

test("readReminder keeps each host's historical submit-time phrasing", () => {
	// Claude/Codex stdio script: prompt subject, Read tool word, no marker.
	assert.equal(
		readReminder(["/a/b.png"], undefined, "prompt", "Read"),
		"The user prompt references the following image file(s):\n" +
			"- /a/b.png\n\n" +
			"Use the Read tool on each image path to inspect it. " +
			"vision-proxy intercepts image reads and supplies a vision-model description as context. " +
			"Do not answer about an image without reading it first.",
	);
	// Pi context and opencode chat.message: message subject, read tool word, marker.
	assert.equal(
		readReminder(["/a/b.png"], "[vision-proxy:read-reminder]", "message", "read"),
		"[vision-proxy:read-reminder] The user message references the following image file(s):\n" +
			"- /a/b.png\n\n" +
			"Use the read tool on each image path to inspect it. " +
			"vision-proxy intercepts image reads and supplies a vision-model description as context. " +
			"Do not answer about an image without reading it first.",
	);
});

test("HOOK_RUNTIME_SOURCE ships the tested functions without drift", () => {
	for (const fn of [
		parsePositiveInt,
		hookTimeoutMs,
		maxOutputTokens,
		vpEntryToSpawn,
		resolveVpBin,
		buildAnalyzeArgs,
		isImagePath,
		resolveImagePath,
		extractImagePaths,
		withImageInstruction,
		readReminder,
	]) {
		assert.ok(
			HOOK_RUNTIME_SOURCE.includes(fn.toString()),
			`runtime source must inline the tested ${fn.name}`,
		);
	}
});

test("HOOK_RUNTIME_SOURCE is safe to embed with String.raw", () => {
	assert.equal(HOOK_RUNTIME_SOURCE.includes("`"), false, "no backticks allowed");
	assert.equal(HOOK_RUNTIME_SOURCE.includes("${"), false, "no ${ allowed");
	assert.ok(HOOK_RUNTIME_SOURCE.includes('"jpg"'), "extension list must be inlined");
	assert.ok(HOOK_RUNTIME_SOURCE.includes("[vision-proxy:read-reminder]"), "marker must be inlined");
});
