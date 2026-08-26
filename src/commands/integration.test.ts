/**
 * Unit tests for `vp integration` install/show/list/uninstall.
 *
 * Exercises the generated Pi extension and the Claude Code / Codex hook
 * registrations against an isolated temp HOME so we never touch a real
 * ~/.claude, ~/.codex, or ~/.pi. Validates:
 *   - install pi writes an executable extension: its input handler is a no-op
 *     so the prompt submit is never blocked, the context event analyzes
 *     attached/referenced images and injects the description into the
 *     messages (preserving the user prompt text), and tool_result replaces
 *     image reads
 *   - install claude-code/codex registers both hooks (UserPromptSubmit +
 *     PreToolUse Read) in the agent config with the absolute `vp hook` path
 *   - uninstall removes only our registrations (idempotent, leaves others intact)
 *   - codex install removes a legacy config.toml [[UserPromptSubmit]] block
 *   - show prints the generated hook command without touching disk
 *   - list/status reflect installed state across agents
 *   - unknown agent/subcommand is rejected
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { runIntegration } from "../commands/integration.ts";
import { VERSION } from "../version.ts";

const ORIG_HOME = process.env.HOME;

function isolate(): string {
	const home = mkdtempSync(join(tmpdir(), "vp-integration-test-"));
	process.env.HOME = home;
	return home;
}

function reset() {
	if (ORIG_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIG_HOME;
}

function installDir(home: string): string {
	return join(home, "ext");
}

/**
 * Create a fake `vp` binary under `<home>/bin` that prints the current
 * VERSION, prepend it to `PATH`, run `fn`, then restore `PATH`. This lets
 * install tests exercise the PATH-resolution path deterministically.
 */
function withVpOnPath<T>(home: string, fn: () => T): T {
	const binDir = join(home, "bin");
	mkdirSync(binDir, { recursive: true });
	const vp = join(binDir, "vp");
	writeFileSync(vp, `#!/bin/sh\necho "${VERSION}"\n`, { mode: 0o755 });
	const origPath = process.env.PATH;
	process.env.PATH = `${binDir}${delimiter}${origPath ?? ""}`;
	try {
		return fn();
	} finally {
		if (origPath === undefined) delete process.env.PATH;
		else process.env.PATH = origPath;
	}
}

/** Return the absolute path to the fake `vp` created by `withVpOnPath`. */
function vpPath(home: string): string {
	return join(home, "bin", "vp");
}

/** Pi's default extensions dir under the isolated HOME (`~/.pi/agent/extensions`). */
function home_pi(): string {
	return join(process.env.HOME!, ".pi", "agent", "extensions");
}

/** Parse a hooks.json config string. */
function parseHooks(raw: string): any {
	return raw.trim() ? JSON.parse(raw) : {};
}

/**
 * Execute a generated source (Pi extension or opencode plugin) with a stubbed
 * `node:child_process` module so handlers can run without spawning real vp
 * processes. Returns the loaded module plus controls for the spawn stub.
 */
interface LoadedGenerated {
	mod: Record<string, unknown>;
	dir: string;
	calls: Array<[string, string[]]>;
	setNextResult(result: unknown): void;
}

async function loadGeneratedSource(
	source: string,
	home: string,
	name: string,
): Promise<LoadedGenerated> {
	const dir = join(home, `${name}-test`);
	mkdirSync(dir, { recursive: true });
	const rewritten = source
		.replace(/"node:child_process"/g, '"./mock-child-process.ts"')
		.replace("__VP_VERSION__PLACEHOLDER__", "// version marker");
	writeFileSync(join(dir, `${name}.ts`), rewritten);
	writeFileSync(
		join(dir, "mock-child-process.ts"),
		[
			"export const calls: Array<[string, string[]]> = [];",
			"let nextResult;",
			"export function setNextResult(r) { nextResult = r; }",
			"export function spawnSync(command, args) { calls.push([command, args]); return nextResult; }",
			"export function spawn(command, args) {",
			"  calls.push([command, args]);",
			"  const result = nextResult;",
			"  let stdoutHandler = null;",
			"  const proc = {",
			"    stdout: { on: (_ev, cb) => { stdoutHandler = cb; } },",
			"    stderr: { on: () => {} },",
			"    on: (ev, cb) => {",
			"      if (ev === 'error') {",
			"        if (result && result.error) setImmediate(() => cb(result.error));",
			"      } else if (ev === 'close') {",
			"        setImmediate(() => {",
			"          if (stdoutHandler && result && result.stdout) stdoutHandler(result.stdout);",
			"          cb(result ? (result.status == null ? 0 : result.status) : 0);",
			"        });",
			"      }",
			"    },",
			"    kill: () => {},",
			"  };",
			"  return proc;",
			"}",
			"",
		].join("\n"),
	);
	const mod = (await import(join(dir, `${name}.ts`))) as Record<string, unknown>;
	return {
		mod,
		dir,
		calls: (await import(join(dir, "mock-child-process.ts"))).calls,
		setNextResult: (await import(join(dir, "mock-child-process.ts"))).setNextResult,
	};
}

/** Write an opaque file with an image extension so existsSync checks pass. */
function fakeImage(dir: string, ...segments: string[]): string {
	const p = join(dir, ...segments);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, "fake-image-bytes");
	return p;
}

/**
 * Load the generated Pi extension and capture its lifecycle handlers.
 * Verifies the public interface contract: a default export setup function
 * registering input, context, and tool_result handlers (no tools).
 */
/**
 * Shape of the generated Pi extension's default export: a setup function
 * receiving an emitter with an `on` registration method.
 */
type PiExtensionSetup = (input: {
	on: (name: string, handler: (event: any) => Promise<unknown>) => void;
}) => unknown;

async function loadPiExtension(source: string, home: string) {
	const { mod, dir, calls, setNextResult } = await loadGeneratedSource(
		source,
		home,
		"vision-proxy",
	);
	assert.equal(
		typeof mod.default,
		"function",
		"generated extension must export a default setup function",
	);
	const events: Record<string, Array<(event: any) => Promise<unknown>>> = {};
	(mod.default as PiExtensionSetup)({
		on: (name: string, handler: (event: any) => Promise<unknown>) => {
			if (!events[name]) {
				events[name] = [];
			}
			events[name].push(handler);
		},
	});
	const eventNames = Object.keys(events);
	assert.ok(!eventNames.includes("registerTool"), "must not register analyze_image tool");
	for (const required of ["input", "context", "tool_result"]) {
		assert.ok(eventNames.includes(required), `must register ${required} handler`);
	}
	return { events, dir, calls, setNextResult };
}

test("install pi writes the vision-proxy extension file with valid source", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("install", "pi", dir);
	assert.equal(r.ok, true);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	const written = readFileSync(target, "utf8");
	await loadPiExtension(written, home);
	reset();
});

test("pi extension analyzes images in the context event without blocking the submit", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const written = readFileSync(join(dir, "vision-proxy.ts"), "utf8");
	const { events, dir: testDir, calls, setNextResult } = await loadPiExtension(written, home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "sub", "photo.jpeg");
	const b64 = Buffer.from("fakepng").toString("base64");
	setNextResult({ status: 0, stdout: "@@FENCE red square@@" });

	// The input handler must NOT block the submit: it returns undefined so the
	// user's prompt is accepted and submitted the instant they press Enter.
	const inputResult = await events.input[0]({
		type: "input",
		text: `look at ${imagePath} please`,
		images: [{ type: "image", data: b64, mimeType: "image/png" }],
	});
	assert.equal(inputResult, undefined, "input must not block the prompt submit");

	// The context event (which fires right before the model call) does the
	// analysis and injects the description into the messages.
	const result = (await events.context[0]({
		type: "context",
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", data: b64, mimeType: "image/png" },
					{ type: "text", text: `look at ${imagePath} please` },
				],
			},
		],
	})) as any;
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	// The image attachment is replaced by the fenced description; the original
	// text (with the referenced path) is preserved for Claude Code / Codex parity.
	assert.ok(!content.some((c) => c.type === "image"), "image block must be replaced");
	const descBlock = content.find(
		(c) => c.type === "text" && c.text?.includes("@@FENCE red square@@"),
	);
	assert.ok(descBlock, "description must be injected");
	assert.match(descBlock!.text!, /Do not use the Read tool on image files/);
	const textBlock = content.find((c) => c.type === "text" && c.text?.includes(imagePath));
	assert.ok(textBlock, "referenced image path must be preserved in the prompt text");
	// One analyze invocation covering the temp copy of the attachment plus the
	// referenced file (the config-get probe is a separate call).
	const analyzeCalls = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeCalls.length, 1);
	const analyzed = analyzeCalls[0]![1];
	assert.equal(analyzed[0], "analyze");
	assert.ok(analyzed.includes(imagePath));
	// The attachment is analyzed via a temp copy (a path outside the test dir).
	assert.ok(analyzed.some((a) => a.startsWith(tmpdir()) && a !== imagePath));
	// The user's prompt is forwarded as --question so the vision model can tailor
	// the description (parity with the Claude Code / Codex vp hook UserPromptSubmit).
	assert.ok(analyzed.includes("--question"), "--question flag must be forwarded");
	assert.ok(
		analyzed.includes(`look at ${imagePath} please`),
		"prompt text must be forwarded as the question",
	);
	reset();
});

test("pi extension resolves a tilde (~) image path in the context event", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	// Image lives directly under HOME so ~/sub/photo.jpeg resolves to it.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const { events, calls, setNextResult } = await loadPiExtension(
		readFileSync(join(dir, "vision-proxy.ts"), "utf8"),
		home,
	);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(home, "sub", "photo.jpeg");
	setNextResult({ status: 0, stdout: "@@FENCE tilde desc@@" });

	const result = (await events.context[0]({
		type: "context",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: `look at ~/sub/photo.jpeg please` }],
			},
		],
	})) as any;
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	const descBlock = content.find(
		(c) => c.type === "text" && c.text?.includes("@@FENCE tilde desc@@"),
	);
	assert.ok(descBlock, "tilde path must be resolved and described");

	// The analyze call must receive the home-expanded absolute path, not the tilde.
	const analyzeCalls = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeCalls.length, 1);
	const analyzed = analyzeCalls[0]![1];
	assert.ok(
		!analyzed.some((a: string) => a.startsWith("~/")),
		"analyze must receive an expanded absolute path",
	);
	assert.ok(analyzed.includes(imagePath), "analyze must receive the home-expanded absolute path");
	reset();
});

test("pi extension context event injects the description into the messages", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });

	// input is a no-op for a normal prompt...
	const inputResult = await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [],
	});
	assert.equal(inputResult, undefined);

	// ...and the context event analyzes and injects the description (wrapped with
	// the "do not Read image files" instruction, mirroring Claude Code / Codex
	// additionalContext).
	const result = (await events.context[0]({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: `see ${imagePath}` }] }],
	})) as any;
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	const descBlock = content.find((c) => c.type === "text" && c.text?.includes("@@FENCE desc@@"));
	assert.ok(descBlock, "description must be injected");
	assert.match(descBlock!.text!, /Do not use the Read tool on image files/);

	// A subsequent image-less prompt yields no description (nothing to analyze).
	const none = await events.context[0]({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: "plain text, no images" }] }],
	});
	assert.equal(none, undefined);
	reset();
});

test("pi extension context event analyzes an image once across repeated context events", async () => {
	// Regression for the notification spam: Pi re-fires the context event for
	// every model call (including after each tool execution), and the original
	// user message still carries its image blocks/paths. Without a description
	// cache the same image was re-analyzed and re-notified on every turn, so
	// "[vision-proxy] Analyzing 1 image(s)..." repeated for each tool result.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "sub", "photo.jpeg");
	const b64 = Buffer.from("fakepng").toString("base64");
	setNextResult({ status: 0, stdout: "@@FENCE red square@@" });

	const notifyCalls: string[] = [];
	const ctxWithNotify = {
		ui: {
			notify: (msg: string) => {
				notifyCalls.push(msg);
			},
		},
	};
	const messageEvent = (msgs: unknown[]) => ({ type: "context", messages: msgs });
	const userMessage = (): any => ({
		role: "user",
		content: [
			{ type: "image", data: b64, mimeType: "image/png" },
			{ type: "text", text: `look at ${imagePath} please` },
		],
	});

	// First context event: analyzes the image and notifies once.
	const first = (await events.context[0](messageEvent([userMessage()]), ctxWithNotify)) as any;
	assert.ok(first?.messages, "first context must return transformed messages");
	const analyzeAfterFirst = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeAfterFirst.length, 1, "must analyze once on first context event");
	assert.equal(notifyCalls.length, 1, "must notify once on first context event");

	// A later context event (e.g. a follow-up turn) re-fires with the same image
	// still present. The description cache must prevent a second analysis and a
	// second notification.
	const second = (await events.context[0](messageEvent([userMessage()]), ctxWithNotify)) as any;
	assert.ok(second?.messages, "second context must return transformed messages");
	const analyzeAfterSecond = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(
		analyzeAfterSecond.length,
		1,
		"must NOT re-analyze the same image on the second context event",
	);
	assert.equal(notifyCalls.length, 1, "must NOT re-notify on the second context event");
	reset();
});

test("pi extension persists the description cache to disk so it survives module reloads", async () => {
	// Regression for the analysis spam across Pi module reloads: a pure in-memory
	// cache was reset every time Pi re-evaluated the extension module, so the
	// same image kept getting re-analyzed. The fix is to back the cache with an
	// on-disk store at ~/.vision-proxy/pi-desc-cache.json (isolated to the test
	// HOME). After the first analysis the file must exist on disk, the entries
	// must be loadable as JSON, and the description must round-trip through it
	// so a fresh process (or a re-imported module after the in-memory cache is
	// cleared) can re-use the cached entry.
	const home = isolate();
	await runIntegration("install", "pi");
	const cachePath = join(home, ".vision-proxy", "pi-desc-cache.json");
	assert.equal(existsSync(cachePath), false, "cache file must not exist before first analysis");

	const source = readFileSync(
		join(process.env.HOME!, ".pi", "agent", "extensions", "vision-proxy.ts"),
		"utf8",
	);
	const { events, dir: testDir, setNextResult } = await loadPiExtension(source, home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "persist.png");
	const b64 = Buffer.from("fakepng").toString("base64");
	setNextResult({ status: 0, stdout: "@@FENCE persisted@@" });
	await events.context[0]({
		type: "context",
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", data: b64, mimeType: "image/png" },
					{ type: "text", text: `see ${imagePath}` },
				],
			},
		],
	});

	// The cache file must be on disk and must contain a parseable JSON object
	// with at least one entry whose description is the one we just produced.
	assert.equal(existsSync(cachePath), true, "cache file must be written after first analysis");
	const raw = readFileSync(cachePath, "utf8");
	const parsed = JSON.parse(raw);
	assert.equal(typeof parsed, "object");
	assert.ok(parsed !== null && !Array.isArray(parsed), "cache must be a JSON object, not an array");
	const entries = Object.values(parsed) as string[];
	assert.ok(entries.length > 0, "cache must contain at least one entry");
	assert.ok(
		entries.some((v) => v.includes("@@FENCE persisted@@")),
		"cache file must contain the description that was just produced",
	);
	reset();
});

test("pi extension keeps the prompt submit instant for queued streaming prompts", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");
	setNextResult({ status: 0, stdout: "@@FENCE queued desc@@" });

	// A queued streaming prompt: input must still return undefined immediately so
	// the submit is never blocked. The analysis happens later in the context event.
	const inputResult = (await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [],
		streamingBehavior: "steer",
	})) as unknown;
	assert.equal(inputResult, undefined, "input must not block the prompt submit");

	// And the context event describes the queued message's referenced image.
	const result = (await events.context[0]({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: `see ${imagePath}` }] }],
	})) as any;
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	const descBlock = content.find(
		(c) => c.type === "text" && c.text?.includes("@@FENCE queued desc@@"),
	);
	assert.ok(descBlock, "queued prompt must be described in context");
	assert.match(descBlock!.text!, /Do not use the Read tool on image files/);

	// A subsequent image-less prompt yields no description from context.
	const idle = await events.context[0]({
		type: "context",
		messages: [
			{ role: "user", content: [{ type: "text", text: "follow-up text only, no images" }] },
		],
	});
	assert.equal(idle, undefined);
	reset();
});

test("pi extension input handler never spawns vp (no blocking config lookup)", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const { events, calls, setNextResult } = await loadPiExtension(
		readFileSync(join(dir, "vision-proxy.ts"), "utf8"),
		home,
	);
	process.env.VP_MODE = "always";
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });

	// The input handler must return immediately and must NOT run a `vp config get`
	// (or any other vp subprocess) synchronously - that blocking lookup used to
	// delay the prompt submit. The mode check belongs in the context event.
	const before = calls.length;
	const inputPromise = events.input[0]({
		type: "input",
		text: "look at something please",
		images: [],
	});
	// Assert immediately, before awaiting: if the handler ever synchronously
	// spawned vp analyze, this catches it on the spot.
	assert.equal(calls.length, before, "input must not spawn vp synchronously");
	const inputResult = await inputPromise;
	assert.equal(inputResult, undefined, "input must not block the prompt submit");
	assert.equal(calls.length, before, "input must not spawn vp");
});

test("pi extension fails open on analyze failure and respects mode off", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	const imagePath = fakeImage(testDir, "pic.png");
	const b64 = Buffer.from("x").toString("base64");

	// vp exits non-zero -> context returns undefined (fail-open).
	process.env.VP_MODE = "always";
	setNextResult({ status: 1, stdout: "" });
	const failed = await events.context[0]({
		type: "context",
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", data: b64, mimeType: "image/png" },
					{ type: "text", text: `see ${imagePath}` },
				],
			},
		],
	});
	assert.equal(failed, undefined);

	// mode off -> input is a no-op and context returns undefined.
	process.env.VP_MODE = "off";
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });
	const inputDisabled = await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [{ type: "image", data: b64, mimeType: "image/png" }],
	});
	assert.equal(inputDisabled, undefined);
	const contextDisabled = await events.context[0]({
		type: "context",
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", data: b64, mimeType: "image/png" },
					{ type: "text", text: `see ${imagePath}` },
				],
			},
		],
	});
	assert.equal(contextDisabled, undefined);
	delete process.env.VP_MODE;
	reset();
});

test("pi extension passes through attachments it cannot analyze", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");
	const unsupported = {
		type: "image" as const,
		data: Buffer.from("svg").toString("base64"),
		mimeType: "image/svg+xml",
	};

	// An unsupported mime attachment plus a referenced image path: the
	// unsupported image block is forwarded unchanged, the referenced path is
	// described and the description is injected into the messages.
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });
	const result = (await events.context[0]({
		type: "context",
		messages: [
			{
				role: "user",
				content: [unsupported, { type: "text", text: `see ${imagePath}` }],
			},
		],
	})) as any;
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	// The unsupported image block survives instead of being dropped...
	assert.ok(
		content.some((c) => c.type === "image"),
		"unsupported image block must pass through",
	);
	// ...and the referenced image path is described and injected.
	const descBlock = content.find((c) => c.type === "text" && c.text?.includes("@@FENCE desc@@"));
	assert.ok(descBlock, "referenced image must be described");
	reset();
});

test("pi extension invalidates the description cache when a referenced file changes", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	// Regression: a screenshot tool or build artifact that always writes the
	// same path (e.g. ./screenshot.png) must produce a fresh description after
	// the file is re-written. A cache key that only used the path would
	// return the stale description for the new image bytes. The cache identity
	// must fold in size + mtime so a re-write is treated as a different image.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "screenshot.png");

	const userMessage = (): any => ({
		role: "user",
		content: [{ type: "text", text: `look at ${imagePath} please` }],
	});

	// First analysis: writes the file with content "AAAA".
	setNextResult({ status: 0, stdout: "@@FENCE first desc@@" });
	const first = (await events.context[0]({ type: "context", messages: [userMessage()] })) as any;
	assert.ok(first?.messages, "first context must return transformed messages");
	const firstContent = first.messages[0].content as Array<{ type: string; text?: string }>;
	assert.ok(
		firstContent.some((c) => c.type === "text" && c.text?.includes("@@FENCE first desc@@")),
		"first analysis must inject the first description",
	);
	const analyzeAfterFirst = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeAfterFirst.length, 1, "must analyze once on first event");

	// Re-write the same path with a different size so the cache key changes.
	// Sleep a millisecond to ensure mtime strictly increases (mtime resolution
	// is often 1s on some filesystems; this protects both resolution regimes).
	await new Promise((r) => setTimeout(r, 5));
	writeFileSync(imagePath, "BBBBBBBB-longer-than-original");

	// Second analysis: must re-analyze because the file changed (size+mtime differ).
	setNextResult({ status: 0, stdout: "@@FENCE second desc@@" });
	const second = (await events.context[0]({ type: "context", messages: [userMessage()] })) as any;
	assert.ok(second?.messages, "second context must return transformed messages");
	const secondContent = second.messages[0].content as Array<{ type: string; text?: string }>;
	assert.ok(
		secondContent.some((c) => c.type === "text" && c.text?.includes("@@FENCE second desc@@")),
		"rewritten file must produce a fresh description (cache invalidated by size+mtime)",
	);
	const analyzeAfterSecond = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeAfterSecond.length, 2, "must re-analyze when referenced file changes");
	reset();
});

test("pi extension keeps the unsupported-mime image block across a cache hit", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	// Regression: a cache hit must not drop the original image block from the
	// returned content. Previously the pass-through only ran in the analyze
	// branch, so the second context event (a cache hit) silently dropped the
	// unsupported image and the model stopped seeing it. The passthrough is now
	// applied to every output, including cache hits.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");
	const unsupported = {
		type: "image" as const,
		data: Buffer.from("svg").toString("base64"),
		mimeType: "image/svg+xml",
	};
	const userMessage = (): any => ({
		role: "user",
		content: [unsupported, { type: "text", text: `see ${imagePath}` }],
	});

	// First context event: analyzes the referenced image. The unsupported
	// image block is passed through alongside the new description.
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });
	const first = (await events.context[0]({ type: "context", messages: [userMessage()] })) as any;
	const firstContent = first.messages[0].content as Array<{
		type: string;
		data?: string;
		mimeType?: string;
		text?: string;
	}>;
	assert.equal(
		firstContent.filter((c) => c.type === "image").length,
		1,
		"first event: unsupported image block must pass through alongside the description",
	);
	const analyzeAfterFirst = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeAfterFirst.length, 1);

	// Second context event: cache hit. The description is reused, but the
	// unsupported image block must STILL be present in the returned content.
	const second = (await events.context[0]({ type: "context", messages: [userMessage()] })) as any;
	const secondContent = second.messages[0].content as Array<{
		type: string;
		data?: string;
		mimeType?: string;
		text?: string;
	}>;
	const images = secondContent.filter((c) => c.type === "image");
	assert.equal(
		images.length,
		1,
		"cache hit: unsupported image block must STILL pass through (not be dropped)",
	);
	assert.equal(images[0]?.data, unsupported.data, "the original bytes must be preserved");
	assert.equal(
		images[0]?.mimeType,
		unsupported.mimeType,
		"the original mime type must be preserved",
	);
	assert.ok(
		secondContent.some((c) => c.type === "text" && c.text?.includes("@@FENCE desc@@")),
		"cache hit: the cached description must still be injected",
	);
	// Crucially: no second analyze call was issued (the cache is doing its job
	// for the analyzable referenced path), so the unsupported image block is
	// the ONLY path that could carry the bytes to the model.
	assert.equal(
		calls.filter(([, args]) => args[0] === "analyze").length,
		1,
		"cache hit: must not re-analyze the analyzable path",
	);
	reset();
});

test("pi extension honors a non-default VP_HOOK_TIMEOUT_MS and falls back on garbage", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		delete process.env.VP_HOOK_TIMEOUT_MS;
		delete process.env.VP_MAX_OUTPUT_TOKENS;
		reset();
	});
	// Regression: the previous code used `Number(process.env.X ?? default)`,
	// which produces NaN for "abc" and a 0ms setTimeout. The new helper must
	// always return a real positive integer from the documented range.
	// We exercise the embedded `parsePositiveInt` by setting the env vars and
	// observing the analyze argv and the resolved TIMEOUT_MS through the
	// extension's observable behavior (no crash; vp is invoked with a sane
	// --max-output-tokens argument).
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	// Malformed values must NOT crash the handler and must NOT inject a NaN or
	// 0 timeout/token. The default fallback (2000) is the only safe value.
	process.env.VP_HOOK_TIMEOUT_MS = "not-a-number";
	process.env.VP_MAX_OUTPUT_TOKENS = "also-bogus";
	const imagePath = fakeImage(testDir, "pic.png");
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });

	const result = (await events.context[0]({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: `see ${imagePath}` }] }],
	})) as any;
	assert.ok(result?.messages, "context must succeed even with malformed env vars");

	const analyzeCalls = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeCalls.length, 1);
	const args = analyzeCalls[0]![1];
	const maxTokensIdx = args.indexOf("--max-output-tokens");
	assert.ok(maxTokensIdx >= 0, "analyze must receive --max-output-tokens");
	const maxTokens = args[maxTokensIdx + 1];
	assert.equal(
		Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0,
		true,
		`--max-output-tokens must be a positive integer, got "${maxTokens}"`,
	);
	assert.equal(maxTokens, "2000", "malformed env must fall back to the default 2000");
	reset();
});

test("pi extension accepts a valid VP_MAX_OUTPUT_TOKENS override", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		delete process.env.VP_MAX_OUTPUT_TOKENS;
		reset();
	});
	// Counterpart to the fallback test: a valid in-range value must reach the
	// vp analyze argv unchanged so users can tune the description length.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	process.env.VP_MAX_OUTPUT_TOKENS = "4096";
	const imagePath = fakeImage(testDir, "pic.png");
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });

	await events.context[0]({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: `see ${imagePath}` }] }],
	});

	const analyzeCalls = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeCalls.length, 1);
	const args = analyzeCalls[0]![1];
	const idx = args.indexOf("--max-output-tokens");
	assert.equal(args[idx + 1], "4096", "in-range override must reach vp analyze");
	reset();
});

test("pi extension replaces read results on image files only", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");

	setNextResult({ status: 0, stdout: "@@FENCE pic desc@@" });
	const replaced = (await events.tool_result[0]({
		type: "tool_result",
		toolName: "read",
		input: { path: imagePath },
		content: [{ type: "image", data: "rawbytes", mimeType: "image/png" }],
		isError: false,
	})) as any;
	assert.match(replaced.content[0].text, /@@FENCE pic desc@@/);

	// Non-image reads pass through untouched.
	const untouched = await events.tool_result[0]({
		type: "tool_result",
		toolName: "read",
		input: { path: join(testDir, "notes.txt") },
		content: [{ type: "text", text: "plain" }],
		isError: false,
	});
	assert.equal(untouched, undefined);
	// Other tools pass through untouched.
	const otherTool = await events.tool_result[0]({
		type: "tool_result",
		toolName: "bash",
		input: { command: "ls" },
		content: [{ type: "text", text: "out" }],
		isError: false,
	});
	assert.equal(otherTool, undefined);
	reset();
});

test("install pi is idempotent (no error on re-install)", async () => {
	const home = isolate();
	const dir = installDir(home);
	const first = await runIntegration("install", "pi", dir);
	assert.equal(first.ok, true);
	const second = await runIntegration("install", "pi", dir);
	assert.equal(second.ok, true);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	reset();
});

test("install claude-code registers both hooks in settings.json with absolute vp path", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	assert.equal(r.ok, true);
	// No shim/shared.mjs files anymore: the hook is the `vp` binary itself.
	assert.equal(existsSync(join(dir, "shared.mjs")), false);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 1);
	assert.equal(cfg.hooks.PreToolUse[0].matcher, "Read");
	const upsCmd = cfg.hooks.UserPromptSubmit[0].hooks[0].command;
	const ptsCmd = cfg.hooks.PreToolUse[0].hooks[0].command;
	const expected = `${vpPath(home)} hook`;
	assert.equal(upsCmd, expected, "UserPromptSubmit hook command must use the PATH-resolved vp");
	assert.equal(ptsCmd, expected, "PreToolUse hook command must use the PATH-resolved vp");
	assert.equal(cfg.hooks.UserPromptSubmit[0].vpManaged, true);
	assert.equal(cfg.hooks.PreToolUse[0].vpManaged, true);
	// Version is embedded in the hook group; no separate marker file is created.
	assert.equal(typeof cfg.hooks.UserPromptSubmit[0].version, "string");
	assert.equal(typeof cfg.hooks.PreToolUse[0].version, "string");
	assert.equal(existsSync(join(home, ".claude", "vision-proxy.hook.json")), false);
	reset();
});

test("install falls back to the invoked script when no vp binary is on PATH", async () => {
	const home = isolate();
	const dir = installDir(home);
	const emptyBin = join(home, "empty-bin");
	mkdirSync(emptyBin, { recursive: true });
	const origPath = process.env.PATH;
	process.env.PATH = emptyBin;
	try {
		const r = await runIntegration("install", "claude-code", dir);
		assert.equal(r.ok, true);
		const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
		const cmd = cfg.hooks.UserPromptSubmit[0].hooks[0].command;
		assert.ok(cmd.startsWith("/"), "fallback command must be absolute");
		assert.ok(cmd.endsWith(" hook"), "fallback command must invoke vp hook");
		assert.match(cmd, /integration\.test\.ts hook$/);
	} finally {
		if (origPath === undefined) delete process.env.PATH;
		else process.env.PATH = origPath;
		reset();
	}
});

test("install codex registers both hooks in hooks.json with absolute vp path", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await withVpOnPath(home, () => runIntegration("install", "codex", dir));
	assert.equal(r.ok, true);
	const cfg = parseHooks(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 1);
	assert.equal(cfg.hooks.PreToolUse[0].matcher, "Read");
	assert.equal(
		cfg.hooks.UserPromptSubmit[0].hooks[0].command,
		`${vpPath(home)} hook`,
		"codex command must use the PATH-resolved vp",
	);
	reset();
});

test("codex install removes a legacy config.toml UserPromptSubmit block", async () => {
	const home = isolate();
	const dir = installDir(home);
	mkdirSync(join(home, ".codex"), { recursive: true });
	writeFileSync(
		join(home, ".codex", "config.toml"),
		'# comment\n[[UserPromptSubmit]]\n\n[[UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "node /old/claude-code-user-prompt-submit.mjs"\n',
	);
	await withVpOnPath(home, () => runIntegration("install", "codex", dir));
	const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
	assert.equal(toml.includes("vision-proxy"), false, "legacy block must be removed");
	// The JSON hook registration must still be present.
	const cfg = parseHooks(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	reset();
});

test("re-install refreshes the absolute vp path and does not duplicate hooks", async () => {
	const home = isolate();
	const dir = installDir(home);
	await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	const first = await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	assert.equal(first.ok, true);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 1);
	assert.equal(cfg.hooks.UserPromptSubmit[0].hooks[0].command, `${vpPath(home)} hook`);
	reset();
});

test("install is idempotent (no duplicate blocks) for claude-code", async () => {
	const home = isolate();
	const dir = installDir(home);
	await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	const first = await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	assert.equal(first.ok, true);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 1);
	reset();
});

test("install claude-code replaces legacy pre-vpManaged shim entries", async () => {
	const home = isolate();
	const dir = installDir(home);
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{
								type: "command",
								command: "node /old/claude-code-user-prompt-submit.mjs",
								timeout: 10,
							},
						],
					},
				],
			},
		}),
	);
	const r = await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	assert.equal(r.ok, true);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 1);
	assert.equal(cfg.hooks.UserPromptSubmit[0].vpManaged, true);
	reset();
});

test("uninstall claude-code removes legacy pre-vpManaged shim entries", async () => {
	const home = isolate();
	const dir = installDir(home);
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{
								type: "command",
								command: "node /old/claude-code-user-prompt-submit.mjs",
								timeout: 10,
							},
						],
					},
				],
			},
		}),
	);
	const r = await runIntegration("uninstall", "claude-code", dir);
	assert.equal(r.ok, true);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks, undefined);
	reset();
});

test("show claude-code prints the hook command without writing to disk", async () => {
	const home = isolate();
	const r = await withVpOnPath(home, () => runIntegration("show", "claude-code"));
	assert.equal(r.ok, true);
	assert.match(
		r.message,
		new RegExp(`${vpPath(home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} hook`),
	);
	assert.equal(existsSync(join(process.env.HOME!, ".claude", "settings.json")), false);
	reset();
});

test("list shows installed state across agents", async () => {
	const home = isolate();
	const dir = installDir(home);
	await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	await withVpOnPath(home, () => runIntegration("install", "codex", dir));
	// pi uses its default ~/.pi location, not the test installDir.
	await runIntegration("install", "pi");
	const r = await runIntegration("list", "");
	assert.match(r.message, /✓ claude-code/);
	assert.match(r.message, /✓ codex/);
	assert.match(r.message, /✓ pi/);
	reset();
});

test("uninstall claude-code removes only the vision-proxy registrations and leaves others", async () => {
	const home = isolate();
	const dir = installDir(home);
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{ hooks: [{ type: "command", command: "node /some/other-hook.mjs", timeout: 10 }] },
				],
			},
		}),
	);
	await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	let cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 2);
	assert.equal(cfg.hooks.PreToolUse.length, 1);
	const r = await runIntegration("uninstall", "claude-code", dir);
	assert.equal(r.ok, true);
	cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.match(cfg.hooks.UserPromptSubmit[0].hooks[0].command, /other-hook\.mjs$/);
	assert.equal(cfg.hooks.PreToolUse, undefined);
	reset();
});

test("uninstall pi removes the file and cleans up an empty extensions directory", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	const r = await runIntegration("uninstall", "pi", dir);
	assert.equal(r.ok, true);
	assert.equal(existsSync(target), false);
	assert.equal(existsSync(dir), false);
	reset();
});

test("uninstall pi reports the correct success message after install (regression)", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	const r = await runIntegration("uninstall", "pi", dir);
	assert.equal(r.ok, true);
	assert.match(r.message, /^uninstalled pi integration/);
	assert.equal(existsSync(target), false);
	reset();
});

test("uninstall of a never-installed agent reports nothing-to-do", async () => {
	isolate();
	const dir = installDir(join(tmpdir(), "vp-unused-"));
	const r = await runIntegration("uninstall", "claude-code", dir);
	assert.equal(r.ok, true);
	assert.match(r.message, /was not installed|absent/);
	reset();
});

test("uninstall pi leaves other files in the extensions directory intact", async () => {
	const home = isolate();
	const dir = installDir(home);
	mkdirSync(dir, { recursive: true });
	const other = join(dir, "other-extension.ts");
	writeFileSync(other, "export default {};");
	await runIntegration("install", "pi", dir);
	const r = await runIntegration("uninstall", "pi", dir);
	assert.equal(r.ok, true);
	assert.equal(existsSync(other), true);
	assert.equal(existsSync(dir), true);
	reset();
});

test("unknown agent is rejected", async () => {
	isolate();
	const r = await runIntegration("install", "vim");
	assert.equal(r.ok, false);
	assert.match(r.message, /unknown agent/);
	reset();
});

test("unknown subcommand reports usage", async () => {
	isolate();
	const r = await runIntegration("frobnicate", "pi");
	assert.equal(r.ok, false);
	assert.match(r.message, /unknown integration subcommand/);
	reset();
});

test("status reports not-installed for every agent on a fresh HOME", async () => {
	isolate();
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, /not installed/);
	assert.match(r.message, /no integrations installed/);
	reset();
});

test("status reports installed version markers and up-to-date summary", async () => {
	isolate(); // pi installs into ~/.pi (temp HOME); status reads the same default location.
	await runIntegration("install", "pi");
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, new RegExp(`✓ pi\\s+${VERSION.replace(/\./g, "\\.")}`));
	assert.match(r.message, /all \d+ integration\(s\) up to date/);
	reset();
});

test("status flags an integration whose embedded version marker is stale", async () => {
	isolate();
	await runIntegration("install", "pi");
	const ext = join(home_pi(), "vision-proxy.ts");
	writeFileSync(
		ext,
		readFileSync(ext, "utf8").replace(/__VP_VERSION__:[0-9.]+/, "__VP_VERSION__:0.0.9"),
	);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(
		r.message,
		new RegExp(`! pi\\s+0\\.0\\.9.*installed vp is ${VERSION.replace(/\./g, "\\.")}`),
	);
	assert.match(r.message, /out of date/);
	reset();
});

test("status reads claude-code version from the hooks config, not a marker file", async () => {
	const home = isolate();
	const dir = installDir(home);
	await withVpOnPath(home, () => runIntegration("install", "claude-code", dir));
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, new RegExp(`✓ claude-code\\s+${VERSION.replace(/\./g, "\\.")}`));
	assert.equal(existsSync(join(home, ".claude", "vision-proxy.hook.json")), false);
	reset();
});
