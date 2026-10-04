/**
 * Unit tests for `vp integration` install/show/list/uninstall.
 *
 * Exercises the generated Pi extension and the Claude Code / Codex hook
 * registrations against an isolated temp HOME so we never touch a real
 * ~/.claude, ~/.codex, or ~/.pi. Validates:
 *   - install pi writes an executable extension: its input handler is a no-op
 *     so the prompt submit is never blocked, the context event appends a
 *     static reminder to read referenced image paths (never spawning vp),
 *     and tool_result replaces image reads with the analyzed description
 *   - install claude/codex writes a plain `vision-proxy_read.ts` hook script
 *     (run via `npx tsx`) and registers the hooks (UserPromptSubmit +
 *     PreToolUse matchers) in the agent config with no vision-proxy metadata keys
 *   - uninstall removes only our registrations and the script (idempotent,
 *     leaves others intact)
 *   - codex install removes a legacy config.toml [[UserPromptSubmit]] block
 *   - show prints the generated hook command without touching disk
 *   - list/status reflect installed state across agents
 *   - unknown agent/subcommand is rejected
 */

import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// A read-only directory only blocks removal for a non-root POSIX user; root
// bypasses directory permissions and chmod does not prevent deletion on
// Windows. Permission-based tests skip where removal cannot be blocked.
const CAN_BLOCK_REMOVAL = process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0;

function installDir(home: string): string {
	return join(home, "ext");
}

/** Absolute path to the generated Claude Code hook script under the isolated HOME. */
function claudeHookPath(home: string): string {
	return join(home, ".claude", "hooks", "vision-proxy_read.ts");
}

/** Absolute path to the generated Codex hook script under the isolated HOME. */
function codexHookPath(home: string): string {
	return join(home, ".codex", "hooks", "vision-proxy_read.ts");
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
 * Execute a generated source (Pi extension) with a stubbed
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
			"    stdin: { on: () => {}, write: () => true, end: () => {} },",
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
			"export function execFile(command, args, options, callback) {",
			"  calls.push([command, args]);",
			"  if (typeof options === 'function') { callback = options; }",
			"  const result = nextResult;",
			"  setImmediate(() => {",
			'    if (!result) { callback(null, "", ""); return; }',
			'    if (result.error) { callback(result.error, result.stdout ?? "", result.stderr ?? ""); return; }',
			"    if (result.status !== 0) {",
			'      const err = new Error("mock vp analyze failed");',
			"      err.code = result.status;",
			'      callback(err, result.stdout ?? "", result.stderr ?? "");',
			"      return;",
			"    }",
			'    callback(null, result.stdout ?? "", result.stderr ?? "");',
			"  });",
			"  return { stdin: { on: () => {}, write: () => true, end: () => {} } };",
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
	for (const required of ["input", "context", "tool_call", "tool_result"]) {
		assert.ok(eventNames.includes(required), `must register ${required} handler`);
	}
	return { events, dir, calls, setNextResult };
}

test("install pi writes the vision-proxy extension file with valid source", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("install", "pi", dir);
	assert.equal(r.ok, true);
	const target = join(dir, "vision-proxy_read.ts");
	assert.equal(existsSync(target), true);
	const written = readFileSync(target, "utf8");
	await loadPiExtension(written, home);
	reset();
});

test("pi extension appends a Read reminder in the context event without spawning vp", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const written = readFileSync(join(dir, "vision-proxy_read.ts"), "utf8");
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

	// The context event (which fires right before the model call) appends a
	// static Read reminder without spawning vp. The actual analysis happens
	// lazily in tool_result when the model reads the image.
	const before = calls.length;
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
	assert.equal(calls.length, before, "context must not spawn vp");
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	// The image attachment is left untouched for native multimodal vision.
	assert.ok(
		content.some((c) => c.type === "image"),
		"image attachment must be left untouched",
	);
	// The reminder names the referenced path and instructs a read.
	const reminder = content.find(
		(c) => c.type === "text" && c.text?.includes("[vision-proxy:read-reminder]"),
	);
	assert.ok(reminder, "read reminder must be appended");
	assert.match(reminder!.text!, /Use the read tool on each image path/);
	assert.ok(reminder!.text!.includes(imagePath), "reminder must name the referenced path");
	reset();
});

test("pi extension resolves a tilde (~) image path in the context reminder", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	// Image lives directly under HOME so ~/sub/photo.jpeg resolves to it.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const { events, calls } = await loadPiExtension(
		readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"),
		home,
	);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(home, "sub", "photo.jpeg");

	const before = calls.length;
	const result = (await events.context[0]({
		type: "context",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: `look at ~/sub/photo.jpeg please` }],
			},
		],
	})) as any;
	assert.equal(calls.length, before, "context must not spawn vp");
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	const reminder = content.find(
		(c) => c.type === "text" && c.text?.includes("[vision-proxy:read-reminder]"),
	);
	assert.ok(reminder, "read reminder must be appended");
	// The reminder names the home-expanded absolute path, not the tilde.
	assert.ok(!reminder!.text!.includes("~/"), "reminder must not contain the unexpanded tilde");
	assert.ok(
		reminder!.text!.includes(imagePath),
		"reminder must name the home-expanded absolute path",
	);
	reset();
});

test("pi extension context event appends a Read reminder to the messages", async (t) => {
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
		calls,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");

	// input is a no-op for a normal prompt...
	const inputResult = await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [],
	});
	assert.equal(inputResult, undefined);

	// ...and the context event appends a static Read reminder without spawning
	// vp (the analysis happens lazily in tool_result when the model reads it).
	const before = calls.length;
	const result = (await events.context[0]({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: `see ${imagePath}` }] }],
	})) as any;
	assert.equal(calls.length, before, "context must not spawn vp");
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	const reminder = content.find(
		(c) => c.type === "text" && c.text?.includes("[vision-proxy:read-reminder]"),
	);
	assert.ok(reminder, "read reminder must be appended");
	assert.match(reminder!.text!, /Use the read tool on each image path/);
	assert.ok(reminder!.text!.includes(imagePath), "reminder must name the image path");

	// A subsequent image-less prompt yields no reminder (nothing to reference).
	const none = await events.context[0]({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: "plain text, no images" }] }],
	});
	assert.equal(none, undefined);
	reset();
});

test("pi extension context event never duplicates the reminder across repeated context events", async () => {
	// Pi re-fires the context event for every model call (including after each
	// tool execution), and the already-reminded message is re-delivered. The
	// handler must strip its own prior reminder before re-appending, so the
	// prompt never stacks duplicate reminder text — and it must never spawn vp.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "sub", "photo.jpeg");
	const b64 = Buffer.from("fakepng").toString("base64");
	const userMessage = (): any => ({
		role: "user",
		content: [
			{ type: "image", data: b64, mimeType: "image/png" },
			{ type: "text", text: `look at ${imagePath} please` },
		],
	});
	const reminders = (msgs: any) =>
		(msgs[0].content as Array<{ type: string; text?: string }>).filter(
			(c) => c.type === "text" && c.text?.includes("[vision-proxy:read-reminder]"),
		);

	// First context event: one reminder appended, no vp spawned.
	const before = calls.length;
	const first = (await events.context[0]({
		type: "context",
		messages: [userMessage()],
	})) as any;
	assert.ok(first?.messages, "first context must return transformed messages");
	assert.equal(calls.length, before, "context must not spawn vp");
	assert.equal(reminders(first.messages).length, 1, "exactly one reminder after first event");

	// Second context event re-fires with the reminded message: still exactly
	// one reminder (stripped and re-appended, not stacked), still no vp spawn.
	const second = (await events.context[0]({
		type: "context",
		messages: first.messages,
	})) as any;
	assert.ok(second?.messages, "second context must return transformed messages");
	assert.equal(calls.length, before, "context must not spawn vp on re-fire");
	assert.equal(reminders(second.messages).length, 1, "must NOT stack a second reminder");
	// The image attachment survives both passes for native multimodal vision.
	assert.ok(
		(second.messages[0].content as Array<{ type: string }>).some((c) => c.type === "image"),
		"image attachment must survive repeated context events",
	);
	delete process.env.VP_MODE;
	reset();
});

test("pi extension context event writes no cache file (reminder-only, no analysis)", async () => {
	// The context event never analyzes, so it must never create
	// ~/.vision-proxy/pi-desc-cache.json: the single analysis point is
	// tool_result, which analyzes the image the model actually reads.
	const home = isolate();
	await runIntegration("install", "pi");
	const cachePath = join(home, ".vision-proxy", "pi-desc-cache.json");
	assert.equal(existsSync(cachePath), false, "cache file must not exist before context");

	const source = readFileSync(
		join(process.env.HOME!, ".pi", "agent", "extensions", "vision-proxy_read.ts"),
		"utf8",
	);
	const { events, dir: testDir, calls } = await loadPiExtension(source, home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "persist.png");
	const b64 = Buffer.from("fakepng").toString("base64");
	const before = calls.length;
	const result = (await events.context[0]({
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
	})) as any;
	assert.ok(result?.messages, "context must still append the reminder");
	assert.equal(calls.length, before, "context must not spawn vp");
	assert.equal(existsSync(cachePath), false, "context must not write a cache file");
	delete process.env.VP_MODE;
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
		calls,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");

	// A queued streaming prompt: input must still return undefined immediately so
	// the submit is never blocked. The reminder is appended later in context.
	const inputResult = (await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [],
		streamingBehavior: "steer",
	})) as unknown;
	assert.equal(inputResult, undefined, "input must not block the prompt submit");

	// And the context event appends a Read reminder for the queued message's
	// referenced image without spawning vp.
	const before = calls.length;
	const result = (await events.context[0]({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: `see ${imagePath}` }] }],
	})) as any;
	assert.equal(calls.length, before, "context must not spawn vp");
	const content = result.messages[0].content as Array<{ type: string; text?: string }>;
	const reminder = content.find(
		(c) => c.type === "text" && c.text?.includes("[vision-proxy:read-reminder]"),
	);
	assert.ok(reminder, "queued prompt must get a Read reminder in context");
	assert.ok(reminder!.text!.includes(imagePath), "reminder must name the image path");

	// A subsequent image-less prompt yields no reminder from context.
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
		readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"),
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
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	const imagePath = fakeImage(testDir, "pic.png");
	const b64 = Buffer.from("x").toString("base64");
	const userMessage = (): any => ({
		role: "user",
		content: [
			{ type: "image", data: b64, mimeType: "image/png" },
			{ type: "text", text: `see ${imagePath}` },
		],
	});

	// vp exits non-zero -> tool_result returns undefined (fail-open), so the
	// original read result reaches the model unchanged.
	process.env.VP_MODE = "always";
	setNextResult({ status: 1, stdout: "" });
	const failed = await events.tool_result[0]({
		type: "tool_result",
		toolName: "read",
		input: { path: imagePath },
		content: [{ type: "image", data: b64, mimeType: "image/png" }],
		isError: false,
	});
	assert.equal(failed, undefined);

	// The context reminder needs no vp call, so it still fires even when vp
	// is broken — the model is told to read, and the read fails open above.
	const reminded = (await events.context[0]({
		type: "context",
		messages: [userMessage()],
	})) as any;
	assert.ok(reminded?.messages, "context reminder must fire even when vp fails");

	// mode off -> input is a no-op, context returns undefined, tool_call
	// leaves input unmutated, tool_result returns undefined.
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
		messages: [userMessage()],
	});
	assert.equal(contextDisabled, undefined);
	const toolDisabled = await events.tool_result[0]({
		type: "tool_result",
		toolName: "read",
		input: { path: imagePath },
		content: [{ type: "image", data: b64, mimeType: "image/png" }],
		isError: false,
	});
	assert.equal(toolDisabled, undefined);
	const callDisabledInput = { command: "vp analyze /tmp/diagram.png" };
	const callDisabled = await events.tool_call[0](
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-1",
			input: callDisabledInput,
		},
		{ sessionManager: { getBranch: () => [] } },
	);
	assert.equal(callDisabled, undefined);
	assert.equal(
		callDisabledInput.command,
		"vp analyze /tmp/diagram.png",
		"mode off must leave the command unmutated",
	);
	delete process.env.VP_MODE;
	reset();
});

test("pi extension leaves attachments untouched and reminds the referenced path", async (t) => {
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
		calls,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");
	const unsupported = {
		type: "image" as const,
		data: Buffer.from("svg").toString("base64"),
		mimeType: "image/svg+xml",
	};

	// An unsupported mime attachment plus a referenced image path: every image
	// block is forwarded unchanged (native multimodal vision), and the
	// referenced path gets a Read reminder — with no vp subprocess.
	const before = calls.length;
	const result = (await events.context[0]({
		type: "context",
		messages: [
			{
				role: "user",
				content: [unsupported, { type: "text", text: `see ${imagePath}` }],
			},
		],
	})) as any;
	assert.equal(calls.length, before, "context must not spawn vp");
	const content = result.messages[0].content as Array<{
		type: string;
		data?: string;
		mimeType?: string;
		text?: string;
	}>;
	// The unsupported image block survives byte-for-byte instead of being dropped...
	const images = content.filter((c) => c.type === "image");
	assert.equal(images.length, 1, "unsupported image block must pass through");
	assert.equal(images[0]?.data, unsupported.data, "the original bytes must be preserved");
	assert.equal(images[0]?.mimeType, unsupported.mimeType, "the original mime must be preserved");
	// ...and the referenced image path gets a Read reminder.
	const reminder = content.find(
		(c) => c.type === "text" && c.text?.includes("[vision-proxy:read-reminder]"),
	);
	assert.ok(reminder, "referenced image must get a Read reminder");
	assert.ok(reminder!.text!.includes(imagePath), "reminder must name the image path");
	reset();
});

test("pi tool_result strips own reminder blocks from analyze context", async (t) => {
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
		calls,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "pic.png");
	setNextResult({ status: 0, stdout: "@@FENCE pi strip desc@@", stderr: "" });
	// The session branch already carries the synthetic reminder persisted by
	// the context handler; tool_result must strip it before formatting so
	// boilerplate never echoes into the vision prompt. The ctx stub exposes
	// sessionManager.getBranch() exactly as the extension reads it.
	const branch = [
		{
			type: "message",
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: "[vision-proxy:read-reminder] The user message references the following image file(s):\n- /tmp/a.png",
					},
					{ type: "text", text: "what is this image about" },
				],
			},
		},
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "reading it now" }] },
		},
	];
	const before = calls.filter(([, args]) => args[0] === "analyze").length;
	const out = (await events.tool_result[0](
		{
			type: "tool_result",
			toolName: "read",
			input: { path: imagePath },
			content: [{ type: "text", text: "raw" }],
			isError: false,
		},
		{ sessionManager: { getBranch: () => branch }, signal: undefined },
	)) as any;
	assert.ok(out, "read with a reminder-carrying branch must produce a description");
	assert.match(out.content[0].text, /@@FENCE pi strip desc@@/);
	assert.equal(
		calls.filter(([, args]) => args[0] === "analyze").length,
		before + 1,
		"must analyze once",
	);
	reset();
});

test("pi tool_call appends a context file to model-invoked analyze", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const { events } = await loadPiExtension(
		readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"),
		home,
	);
	process.env.VP_MODE = "always";
	const branch = [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "Which shape is this?" }] },
		},
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "A square." }] },
		},
	];
	const input = { command: "vp analyze /tmp/diagram.png" };
	const result = await events.tool_call[0](
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-2",
			input,
		},
		{ sessionManager: { getBranch: () => branch } },
	);
	assert.equal(result, undefined, "mutation carries the rewrite; no block result");
	assert.match(input.command, /^vp analyze \/tmp\/diagram\.png --context-file /);
	assert.ok(!input.command.includes("Which shape"), "context must not leak onto argv");
	const filePath = input.command.slice(input.command.indexOf("--context-file ") + 15).trim();
	const unquoted =
		filePath.startsWith("'") && filePath.endsWith("'")
			? filePath.slice(1, -1).replace(/'\\''/g, "'")
			: filePath;
	const saved = readFileSync(unquoted, "utf8");
	assert.ok(saved.includes("Which shape is this?"), "tempfile must carry the context");
	rmSync(unquoted);
});

test("pi tool_call leaves flagged, non-bash, and context-less calls alone", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const { events } = await loadPiExtension(
		readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"),
		home,
	);
	process.env.VP_MODE = "always";
	const branchCtx = {
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Which shape?" }] },
				},
			],
		},
	};
	const emptyCtx = { sessionManager: { getBranch: () => [] } };
	// Compound and non-binary commands carry context yet must stay
	// unmutated: the detector rejects them (flag would land on the wrong
	// process), and the pending fallback must not fire for them either.
	for (const command of [
		"vp analyze /tmp/a.png && echo done",
		"vp analyze /tmp/a.png; echo done",
		"echo vp analyze /tmp/a.png",
	]) {
		const input = { command };
		const result = await events.tool_call[0](
			{ type: "tool_call", toolName: "bash", toolCallId: "call-x", input },
			branchCtx,
		);
		assert.equal(result, undefined);
		assert.equal(input.command, command, `must leave ${command} unmutated`);
	}
	for (const event of [
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-3",
			input: { command: "vp analyze /tmp/a.png --context-file /tmp/ctx.txt" },
		},
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-4",
			input: { command: "ls /tmp" },
		},
		{
			type: "tool_call",
			toolName: "read",
			toolCallId: "call-5",
			input: { path: "/tmp/diagram.png" },
		},
	]) {
		const before = JSON.stringify(event.input);
		const result = await events.tool_call[0](event, emptyCtx);
		assert.equal(result, undefined);
		assert.equal(JSON.stringify(event.input), before, "input must stay unmutated");
	}
});

test("pi extension analyzes a rewritten file fresh on every tool_result read", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	// There is no description cache anymore: each model read of an image goes
	// through vp analyze, so a screenshot tool or build artifact that always
	// writes the same path (e.g. ./screenshot.png) always produces a fresh
	// description for the current bytes. Stale descriptions are impossible.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "screenshot.png");
	const readEvent = (): any => ({
		type: "tool_result",
		toolName: "read",
		input: { path: imagePath },
		content: [{ type: "image", data: "rawbytes", mimeType: "image/png" }],
		isError: false,
	});

	setNextResult({ status: 0, stdout: "@@FENCE first desc@@" });
	const first = (await events.tool_result[0](readEvent())) as any;
	assert.match(first.content[0].text, /@@FENCE first desc@@/);
	const analyzeAfterFirst = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeAfterFirst.length, 1, "must analyze once on first read");

	writeFileSync(imagePath, "BBBBBBBB-longer-than-original");

	setNextResult({ status: 0, stdout: "@@FENCE second desc@@" });
	const second = (await events.tool_result[0](readEvent())) as any;
	assert.match(
		second.content[0].text,
		/@@FENCE second desc@@/,
		"rewritten file must produce a fresh description (no stale cache)",
	);
	const analyzeAfterSecond = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeAfterSecond.length, 2, "must re-analyze on every read");
	reset();
});

test("pi extension preserves the image block across repeated reminder events", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	// Pi re-fires context on every model call, so the handler runs repeatedly
	// over messages it already reminded. Each pass must preserve the original
	// image bytes, carry exactly one reminder, and never spawn vp — the image
	// reaches the model natively on every turn until it is read and described
	// by tool_result.
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
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

	// First context event: image passes through, one reminder appended, no vp.
	const before = calls.length;
	const first = (await events.context[0]({ type: "context", messages: [userMessage()] })) as any;
	assert.equal(calls.length, before, "first event: context must not spawn vp");
	const firstContent = first.messages[0].content as Array<{
		type: string;
		data?: string;
		mimeType?: string;
		text?: string;
	}>;
	assert.equal(
		firstContent.filter((c) => c.type === "image").length,
		1,
		"first event: image block must pass through alongside the reminder",
	);
	assert.equal(
		firstContent.filter(
			(c) => c.type === "text" && c.text?.includes("[vision-proxy:read-reminder]"),
		).length,
		1,
		"first event: exactly one reminder",
	);

	// Second context event over the reminded message: image STILL present,
	// still exactly one reminder, still no vp.
	const second = (await events.context[0]({ type: "context", messages: first.messages })) as any;
	assert.equal(calls.length, before, "second event: context must not spawn vp");
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
		"second event: image block must STILL pass through (not be dropped)",
	);
	assert.equal(images[0]?.data, unsupported.data, "the original bytes must be preserved");
	assert.equal(
		images[0]?.mimeType,
		unsupported.mimeType,
		"the original mime type must be preserved",
	);
	assert.equal(
		secondContent.filter(
			(c) => c.type === "text" && c.text?.includes("[vision-proxy:read-reminder]"),
		).length,
		1,
		"second event: still exactly one reminder (not stacked)",
	);
	reset();
});

test("pi extension writes context files without a Buffer global (fail-open)", async (t) => {
	t.after(() => {
		delete process.env.VP_MODE;
		reset();
	});
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const source = readFileSync(join(dir, "vision-proxy_read.ts"), "utf8");
	assert.ok(
		!source.includes('from "node:buffer"'),
		"Pi artifact must not import node:buffer (no Buffer global assumed)",
	);
	const { events } = await loadPiExtension(source, home);
	process.env.VP_MODE = "always";
	const toolContext = "session context for the pending fallback";
	const disabled = await events.tool_call[0](
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-no-buffer",
			input: { command: "node server.js" },
		},
		{
			sessionManager: {
				getBranch: () => [{ type: "message", message: { role: "user", content: toolContext } }],
			},
		},
	);
	assert.equal(disabled, undefined, "tool_call must fail open without Buffer");
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
	// observing the analyze argv through the tool_result handler's observable
	// behavior (no crash; vp is invoked with a sane --max-output-tokens).
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const {
		events,
		dir: testDir,
		calls,
		setNextResult,
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	// Malformed values must NOT crash the handler and must NOT inject a NaN or
	// 0 timeout/token. The default fallback (2000) is the only safe value.
	process.env.VP_HOOK_TIMEOUT_MS = "not-a-number";
	process.env.VP_MAX_OUTPUT_TOKENS = "also-bogus";
	const imagePath = fakeImage(testDir, "pic.png");
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });

	const result = (await events.tool_result[0]({
		type: "tool_result",
		toolName: "read",
		input: { path: imagePath },
		content: [{ type: "image", data: "rawbytes", mimeType: "image/png" }],
		isError: false,
	})) as any;
	assert.ok(result?.content, "tool_result must succeed even with malformed env vars");

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
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
	process.env.VP_MODE = "always";
	process.env.VP_MAX_OUTPUT_TOKENS = "4096";
	const imagePath = fakeImage(testDir, "pic.png");
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });

	await events.tool_result[0]({
		type: "tool_result",
		toolName: "read",
		input: { path: imagePath },
		content: [{ type: "image", data: "rawbytes", mimeType: "image/png" }],
		isError: false,
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
	} = await loadPiExtension(readFileSync(join(dir, "vision-proxy_read.ts"), "utf8"), home);
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
	const target = join(dir, "vision-proxy_read.ts");
	assert.equal(existsSync(target), true);
	reset();
});

test("install claude writes a tsx hook script and metadata-free settings.json entries", async () => {
	const home = isolate();
	const r = await runIntegration("install", "claude");
	assert.equal(r.ok, true);
	// The generated hook script lands in ~/.claude/hooks with a version marker.
	const script = claudeHookPath(home);
	assert.equal(existsSync(script), true);
	const source = readFileSync(script, "utf8");
	assert.match(source, /npx tsx/);
	assert.match(source, new RegExp(`__VP_VERSION__:${VERSION.replace(/\./g, "\\.")}`));
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 2);
	assert.deepEqual(
		cfg.hooks.PreToolUse.map((group: { matcher: string }) => group.matcher),
		["Read", "Bash"],
	);
	const expected = `npx tsx ${script}`;
	assert.equal(
		cfg.hooks.UserPromptSubmit[0].hooks[0].command,
		expected,
		"UserPromptSubmit hook command must invoke the generated script via npx tsx",
	);
	assert.equal(
		cfg.hooks.PreToolUse[0].hooks[0].command,
		expected,
		"PreToolUse hook command must invoke the generated script via npx tsx",
	);
	// No vision-proxy metadata keys in the host config.
	assert.equal("vpManaged" in cfg.hooks.UserPromptSubmit[0], false);
	assert.equal("vpManaged" in cfg.hooks.PreToolUse[0], false);
	assert.equal("version" in cfg.hooks.UserPromptSubmit[0], false);
	assert.equal("version" in cfg.hooks.PreToolUse[0], false);
	assert.equal(existsSync(join(home, ".claude", "vision-proxy.hook.json")), false);
	reset();
});

test("install codex writes its hook script under ~/.codex and registers it in hooks.json", async () => {
	const home = isolate();
	const r = await runIntegration("install", "codex");
	assert.equal(r.ok, true);
	const script = codexHookPath(home);
	assert.equal(existsSync(script), true);
	const source = readFileSync(script, "utf8");
	assert.match(source, /npx tsx/);
	assert.match(source, new RegExp(`__VP_VERSION__:${VERSION.replace(/\./g, "\\.")}`));
	const cfg = parseHooks(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 3);
	assert.deepEqual(
		cfg.hooks.PreToolUse.map((group: { matcher: string }) => group.matcher),
		["Read", "view_image", "Bash"],
	);
	assert.equal(
		cfg.hooks.UserPromptSubmit[0].hooks[0].command,
		`npx tsx ${script}`,
		"codex command must invoke the generated script via npx tsx",
	);
	assert.equal("vpManaged" in cfg.hooks.UserPromptSubmit[0], false);
	assert.equal("version" in cfg.hooks.UserPromptSubmit[0], false);
	reset();
});

test("codex install removes a legacy config.toml UserPromptSubmit block", async () => {
	const home = isolate();
	mkdirSync(join(home, ".codex"), { recursive: true });
	writeFileSync(
		join(home, ".codex", "config.toml"),
		'# comment\n[[UserPromptSubmit]]\n\n[[UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "node /old/claude-code-user-prompt-submit.mjs"\n',
	);
	await runIntegration("install", "codex");
	const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
	assert.equal(toml.includes("vision-proxy"), false, "legacy block must be removed");
	// The JSON hook registration must still be present.
	const cfg = parseHooks(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	reset();
});

test("re-install does not duplicate hooks or scripts", async () => {
	const home = isolate();
	await runIntegration("install", "claude");
	const first = await runIntegration("install", "claude");
	assert.equal(first.ok, true);
	assert.match(
		first.message,
		new RegExp(`claude integration already up to date \\(${VERSION.replace(/\./g, "\\.")}\\)`),
		"identical reinstall must say so instead of claiming a fresh install",
	);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 2);
	assert.equal(cfg.hooks.UserPromptSubmit[0].hooks[0].command, `npx tsx ${claudeHookPath(home)}`);
	reset();
});

test("reinstall over a stale artifact reports the replaced version", async () => {
	const home = isolate();
	await runIntegration("install", "claude");
	const script = claudeHookPath(home);
	// Simulate drift (e.g. an older release or an unreleased-branch edit):
	// same install, older marker plus one changed byte.
	writeFileSync(
		script,
		readFileSync(script, "utf8")
			.replace(
				new RegExp(`__VP_VERSION__:${VERSION.replace(/\./g, "\\.")}`),
				"__VP_VERSION__:0.0.9",
			)
			.replace("vision-proxy", "vision-proxx"),
	);
	const r = await runIntegration("install", "claude");
	assert.equal(r.ok, true);
	assert.match(
		r.message,
		/reinstalled claude integration \(replaced 0\.0\.9 with /,
		"reinstall must warn that it overwrote a differing artifact",
	);
	// The artifact is refreshed to the generated content.
	assert.match(
		readFileSync(script, "utf8"),
		new RegExp(`__VP_VERSION__:${VERSION.replace(/\./g, "\\.")}`),
	);
	reset();
});

test("fresh install still reports an install lead", async () => {
	isolate();
	const r = await runIntegration("install", "pi");
	assert.equal(r.ok, true);
	assert.match(r.message, /installed pi extension ->/);
	reset();
});
test("install is idempotent (no duplicate blocks) for claude", async () => {
	isolate();
	await runIntegration("install", "claude");
	const first = await runIntegration("install", "claude");
	assert.equal(first.ok, true);
	const cfg = parseHooks(readFileSync(join(process.env.HOME!, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 2);
	reset();
});

test("install claude replaces legacy vp hook entries", async () => {
	const home = isolate();
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
	const r = await runIntegration("install", "claude");
	assert.equal(r.ok, true);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.equal(cfg.hooks.PreToolUse.length, 2);
	assert.equal(cfg.hooks.UserPromptSubmit[0].hooks[0].command, `npx tsx ${claudeHookPath(home)}`);
	assert.equal("vpManaged" in cfg.hooks.UserPromptSubmit[0], false);
	assert.equal(existsSync(claudeHookPath(home)), true);
	reset();
});

test("uninstall claude removes legacy shim entries and the script", async () => {
	const home = isolate();
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
	const r = await runIntegration("uninstall", "claude");
	assert.equal(r.ok, true);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks, undefined);
	assert.equal(existsSync(claudeHookPath(home)), false);
	reset();
});

test("show claude prints the hook command without writing to disk", async () => {
	const home = isolate();
	const r = await runIntegration("show", "claude");
	assert.equal(r.ok, true);
	assert.match(r.message, /npx tsx .*vision-proxy_read\.ts/);
	assert.match(r.message, /vision-proxy_read\.ts/);
	assert.equal(existsSync(join(process.env.HOME!, ".claude", "settings.json")), false);
	assert.equal(existsSync(claudeHookPath(home)), false);
	reset();
});

test("install claude mentions the tsx prerequisite in its message", async () => {
	isolate();
	const r = await runIntegration("install", "claude");
	assert.equal(r.ok, true);
	assert.match(r.message, /tsx/);
	reset();
});

test("show pi omits the empty hook-command line", async () => {
	isolate();
	const r = await runIntegration("show", "pi");
	assert.equal(r.ok, true);
	assert.equal(r.message.includes("hook command:"), false);
	assert.match(r.message, /extension file/);
	reset();
});

test("list shows installed state across agents", async () => {
	isolate();
	await runIntegration("install", "claude");
	await runIntegration("install", "codex");
	// pi uses its default ~/.pi location, not the test installDir.
	await runIntegration("install", "pi");
	const r = await runIntegration("list", "");
	assert.match(r.message, /✓ claude/);
	assert.match(r.message, /✓ codex/);
	assert.match(r.message, /✓ pi/);
	reset();
});

test("uninstall claude removes only the vision-proxy registrations and leaves others", async () => {
	const home = isolate();
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
	await runIntegration("install", "claude");
	assert.equal(existsSync(claudeHookPath(home)), true);
	let cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 2);
	assert.equal(cfg.hooks.PreToolUse.length, 2);
	const r = await runIntegration("uninstall", "claude");
	assert.equal(r.ok, true);
	cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.match(cfg.hooks.UserPromptSubmit[0].hooks[0].command, /other-hook\.mjs$/);
	assert.equal(cfg.hooks.PreToolUse, undefined);
	assert.equal(existsSync(claudeHookPath(home)), false);
	reset();
});

test("uninstall pi removes the file and cleans up an empty extensions directory", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const target = join(dir, "vision-proxy_read.ts");
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
	const target = join(dir, "vision-proxy_read.ts");
	assert.equal(existsSync(target), true);
	const r = await runIntegration("uninstall", "pi", dir);
	assert.equal(r.ok, true);
	assert.match(r.message, /^uninstalled pi integration/);
	assert.equal(existsSync(target), false);
	reset();
});

test("uninstall preserves a foreign config when no registration is removed", async () => {
	const home = isolate();
	const configPath = join(home, ".claude", "settings.json");
	mkdirSync(dirname(configPath), { recursive: true });
	const raw = '{\n  "hooks": {\n    "UserPromptSubmit": []\n  }\n}\n';
	writeFileSync(configPath, raw);
	const r = await runIntegration("uninstall", "claude");
	assert.equal(r.ok, true);
	assert.match(r.message, /was not installed|absent/);
	assert.equal(readFileSync(configPath, "utf8"), raw);
	reset();
});

test("uninstall of a never-installed agent reports nothing-to-do", async () => {
	isolate();
	const r = await runIntegration("uninstall", "claude");
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

test("uninstall --all removes every integration and clears legacy opencode files", async () => {
	const home = isolate();
	await runIntegration("install", "pi");
	await runIntegration("install", "claude");
	await runIntegration("install", "codex");
	const opencodeDir = legacyOpencodeDir(home);
	mkdirSync(opencodeDir, { recursive: true });
	writeFileSync(join(opencodeDir, "vision-proxy_read.ts"), `__VP_VERSION__:0.0.9\n`);
	const r = await runIntegration("uninstall", "", undefined, false, true);
	assert.equal(r.ok, true);
	assert.equal(r.code, 0);
	const lines = r.message.split("\n");
	assert.equal(lines.length, 4);
	assert.deepEqual(
		lines.map((l) => l.split(":")[0]),
		["pi", "claude", "codex", "opencode"],
	);
	for (const line of lines) assert.match(line, /^(pi|claude|codex|opencode): .+/);
	assert.equal(existsSync(join(home_pi(), "vision-proxy_read.ts")), false);
	assert.equal(existsSync(claudeHookPath(home)), false);
	assert.equal(existsSync(codexHookPath(home)), false);
	assert.equal(existsSync(join(opencodeDir, "vision-proxy_read.ts")), false);
	reset();
});

test("uninstall --all with no integrations reports nothing installed per agent", async () => {
	isolate();
	const r = await runIntegration("uninstall", "", undefined, false, true);
	assert.equal(r.ok, true);
	assert.equal(r.code, 0);
	assert.match(r.message, /pi: /);
	assert.match(r.message, /claude: /);
	assert.match(r.message, /codex: /);
	assert.match(r.message, /opencode: /);
	reset();
});

test("uninstall --all rejects an explicit agent", async () => {
	isolate();
	const r = await runIntegration("uninstall", "pi", undefined, false, true);
	assert.equal(r.ok, false);
	assert.equal(r.code, 1);
	assert.match(r.message, /usage: vp integration uninstall <agent> \| --all/);
	reset();
});

test("claude-code alias resolves to the same install as claude", async () => {
	const home = isolate();
	const viaAlias = await runIntegration("install", "claude-code");
	assert.equal(viaAlias.ok, true);
	// Messages are canonical: the alias never leaks into output.
	assert.match(viaAlias.message, /installed claude integration/);
	assert.ok(!viaAlias.message.includes("claude-code"));
	assert.equal(existsSync(claudeHookPath(home)), true);
	// Show/uninstall through the alias act on the same artifact.
	const show = await runIntegration("show", "claude-code");
	assert.equal(show.ok, true);
	const uninstall = await runIntegration("uninstall", "claude-code");
	assert.equal(uninstall.ok, true);
	assert.match(uninstall.message, /uninstalled claude integration/);
	assert.equal(existsSync(claudeHookPath(home)), false);
	reset();
});

test("uninstall without an agent points at --all", async () => {
	isolate();
	const r = await runIntegration("uninstall", "");
	assert.equal(r.ok, false);
	assert.equal(r.code, 1);
	assert.match(r.message, /usage: vp integration uninstall <agent> \| --all/);
	reset();
});

test("uninstall --all keeps going when one agent uninstall fails", async () => {
	if (!CAN_BLOCK_REMOVAL) return;
	const home = isolate();
	await runIntegration("install", "claude");
	// A read-only extensions dir blocks pi's artifact + dir removal, so pi
	// fails while claude still uninstalls cleanly.
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	const piTarget = join(piDir, "vision-proxy_read.ts");
	writeFileSync(piTarget, `__VP_VERSION__:0.0.9\n`);
	chmodSync(piDir, 0o555);
	try {
		const r = await runIntegration("uninstall", "", undefined, false, true);
		assert.equal(r.ok, false);
		assert.equal(r.code, 1);
		assert.match(r.message, /pi: failed to remove/);
		assert.match(r.message, /claude: uninstalled/);
		assert.equal(existsSync(claudeHookPath(home)), false);
		assert.equal(existsSync(piTarget), true);
	} finally {
		chmodSync(piDir, 0o755);
		reset();
	}
});

test("uninstall --all converts a per-agent rejection into a failed line", async () => {
	// settings.json as a directory makes readConfig's readFileSync throw
	// (EISDIR); --all must convert the rejection to a failed line and
	// continue with the later agents instead of aborting.
	const home = isolate();
	const configPath = join(home, ".claude", "settings.json");
	mkdirSync(dirname(configPath), { recursive: true });
	mkdirSync(configPath);
	const r = await runIntegration("uninstall", "", undefined, false, true);
	assert.equal(r.ok, false);
	assert.equal(r.code, 1);
	assert.match(r.message, /claude: failed to uninstall claude integration: /);
	// Later agents still ran and reported their lines.
	assert.match(r.message, /codex: /);
	assert.match(r.message, /opencode: /);
	reset();
});

test("unknown agent is rejected", async () => {
	isolate();
	const r = await runIntegration("install", "vim");
	assert.equal(r.ok, false);
	assert.match(r.message, /unknown agent/);
	reset();
});

test("opencode install and show are paused with a v2 message", async () => {
	// opencode removed while its v2 plugin API stabilizes: install and show
	// must explain the pause instead of acting. (uninstall is the orphan
	// cleanup path and is covered below.)
	isolate();
	for (const sub of ["install", "show"] as const) {
		const r = await runIntegration(sub, "opencode");
		assert.equal(r.ok, false);
		assert.match(r.message, /opencode support is paused/);
	}
	reset();
});

/** Legacy v1 opencode plugin dir under the isolated HOME. */
function legacyOpencodeDir(home: string): string {
	return join(home, ".config", "opencode", "plugins");
}

test("status reports a legacy opencode plugin file when present", async () => {
	const home = isolate();
	const dir = legacyOpencodeDir(home);
	mkdirSync(dir, { recursive: true });
	const legacy = join(dir, "vision-proxy_read.ts");
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\n`);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(
		r.message,
		/! opencode\s+legacy install at .+vision-proxy_read\.ts - run: vp integration uninstall opencode/,
	);
	assert.match(r.message, /out of date/);
	reset();
});

test("status counts a two-file opencode legacy as one integration", async () => {
	const home = isolate();
	const dir = legacyOpencodeDir(home);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "vision-proxy.ts"), `__VP_VERSION__:0.0.9\\n`);
	writeFileSync(join(dir, "vision-proxy_read.ts"), `__VP_VERSION__:0.0.9\\n`);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, /1 of 1 integration\(s\) out of date/);
	reset();
});

test("status reports the pre-suffix legacy opencode plugin file", async () => {
	const home = isolate();
	const dir = legacyOpencodeDir(home);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "vision-proxy.ts"), `__VP_VERSION__:0.0.9\n`);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, /! opencode\s+legacy install at .+vision-proxy\.ts/);
	reset();
});

test("status omits opencode with no legacy plugin file", async () => {
	isolate();
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.ok(!r.message.includes("opencode"), "no legacy file means no opencode line");
	assert.match(r.message, /no integrations installed/);
	reset();
});

test("uninstall opencode removes legacy plugin files and reports them", async () => {
	const home = isolate();
	const dir = legacyOpencodeDir(home);
	mkdirSync(dir, { recursive: true });
	const suffixed = join(dir, "vision-proxy_read.ts");
	const legacy = join(dir, "vision-proxy.ts");
	writeFileSync(suffixed, `__VP_VERSION__:0.0.9\n`);
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\n`);
	// An unrelated plugin must survive the cleanup.
	const other = join(dir, "other-plugin.ts");
	writeFileSync(other, "export default {};");
	// A user-authored file sharing only the prefix must also survive: only
	// the two exact legacy filenames are ever removed.
	const decoy = join(dir, "vision-proxy-notes.ts");
	writeFileSync(decoy, "export default {};");
	const r = await runIntegration("uninstall", "opencode");
	assert.equal(r.ok, true);
	assert.match(r.message, /uninstalled opencode integration/);
	assert.match(r.message, /vision-proxy_read\.ts/);
	assert.match(r.message, /vision-proxy\.ts/);
	assert.equal(existsSync(suffixed), false);
	assert.equal(existsSync(legacy), false);
	assert.equal(existsSync(other), true);
	assert.equal(existsSync(decoy), true);
	assert.equal(existsSync(dir), true, "shared plugins dir is left in place");
	reset();
});

test("uninstall opencode with no legacy file reports absent cleanly", async () => {
	isolate();
	const r = await runIntegration("uninstall", "opencode");
	assert.equal(r.ok, true);
	assert.match(r.message, /not installed/);
	reset();
});

test("uninstall opencode honors the installDir override", async () => {
	const home = isolate();
	const dir = join(home, "ext");
	mkdirSync(dir, { recursive: true });
	const legacy = join(dir, "vision-proxy_read.ts");
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\n`);
	// A same-named file in the real home-relative plugins dir must survive:
	// the override scopes both enumeration and deletion to `dir`.
	const homePlugins = legacyOpencodeDir(home);
	mkdirSync(homePlugins, { recursive: true });
	const homeLegacy = join(homePlugins, "vision-proxy_read.ts");
	writeFileSync(homeLegacy, `__VP_VERSION__:0.0.9\n`);
	const r = await runIntegration("uninstall", "opencode", dir);
	assert.equal(r.ok, true);
	assert.match(r.message, /uninstalled opencode integration/);
	assert.equal(existsSync(legacy), false);
	assert.equal(
		existsSync(homeLegacy),
		true,
		"home-relative file must survive an override uninstall",
	);
	reset();
});

test("status names the inspected dir in the uninstall hint for installDir callers", async () => {
	const home = isolate();
	const dir = join(home, "ext");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "vision-proxy_read.ts"), `__VP_VERSION__:0.0.9\n`);
	const r = await runIntegration("status", "", dir);
	assert.equal(r.ok, true);
	assert.match(r.message, /uninstall with the same installDir/);
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

test("status surfaces a dev-stamped binary and hides prod installs", async () => {
	isolate();
	await runIntegration("install", "pi");
	const ext = join(home_pi(), "vision-proxy_read.ts");
	// A --dev install stamps the local CLI entry point: status must say so.
	writeFileSync(
		ext,
		readFileSync(ext, "utf8").replace(
			'var DEFAULT_VP_BIN = "vp";',
			'var DEFAULT_VP_BIN = "/work/vision-proxy/dist/cli.js";',
		),
	);
	const dev = await runIntegration("status", "");
	assert.equal(dev.ok, true);
	assert.match(
		dev.message,
		/✓ pi\s+\S+ \(dev: \/work\/vision-proxy\/dist\/cli\.js\)/,
		"dev wiring must be visible in status",
	);
	// A crafted artifact with control characters in the stamped path must
	// not inject status lines: the dev suffix is dropped, fail-open. The
	// stamp line is built by concatenating a backslash-n escape at runtime
	// (a literal backslash-n in source would decode too early and never
	// exercise the control-char reject). Note: the previous block replaced
	// the prod marker with the dev path, so match the current file content.
	const backslashN = String.fromCharCode(92, 110);
	writeFileSync(
		ext,
		readFileSync(ext, "utf8").replace(
			'var DEFAULT_VP_BIN = "/work/vision-proxy/dist/cli.js";',
			`var DEFAULT_VP_BIN = "/tmp/evil${backslashN}✓ forged status";`,
		),
	);
	const forged = await runIntegration("status", "");
	assert.ok(
		forged.message.split("\n").some((l) => /^✓ pi\s+\S+$/.test(l)),
		"control-char stamped paths degrade to the bare marker line",
	);
	assert.ok(!forged.message.includes("forged status"), "injected lines must not render");
	// A plain PATH install renders exactly as before (no suffix).
	writeFileSync(
		ext,
		readFileSync(ext, "utf8").replace(
			'var DEFAULT_VP_BIN = "/work/vision-proxy/dist/cli.js";',
			'var DEFAULT_VP_BIN = "vp";',
		),
	);
	const prod = await runIntegration("status", "");
	assert.ok(
		prod.message.split("\n").some((l) => /^✓ pi\s+\S+$/.test(l)),
		"prod installs keep the bare marker line",
	);
	reset();
});

test("status flags an integration whose embedded version marker is stale", async () => {
	isolate();
	await runIntegration("install", "pi");
	const ext = join(home_pi(), "vision-proxy_read.ts");
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

test("status reads claude version from the hook script, with a metadata-free config", async () => {
	const home = isolate();
	await runIntegration("install", "claude");
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, new RegExp(`✓ claude\\s+${VERSION.replace(/\./g, "\\.")}`));
	assert.equal(existsSync(join(home, ".claude", "vision-proxy.hook.json")), false);
	const cfg = parseHooks(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal("vpManaged" in cfg.hooks.UserPromptSubmit[0], false);
	assert.equal("version" in cfg.hooks.UserPromptSubmit[0], false);
	reset();
});

test("status flags a stale claude hook script version", async () => {
	isolate();
	await runIntegration("install", "claude");
	const script = join(process.env.HOME!, ".claude", "hooks", "vision-proxy_read.ts");
	writeFileSync(
		script,
		readFileSync(script, "utf8").replace(/__VP_VERSION__:[0-9.]+/, "__VP_VERSION__:0.0.9"),
	);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(
		r.message,
		new RegExp(`! claude\\s+0\\.0\\.9.*installed vp is ${VERSION.replace(/\./g, "\\.")}`),
	);
	assert.match(r.message, /out of date/);
	reset();
});

test("install removes a marker-stamped legacy artifact next to the new one", async () => {
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	const legacy = join(piDir, "vision-proxy.ts");
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\nconsole.log("legacy");\n`);
	await runIntegration("install", "pi");
	assert.equal(existsSync(legacy), false, "marker-stamped legacy artifact must be removed");
	assert.equal(existsSync(join(piDir, "vision-proxy_read.ts")), true);
	reset();
});

test("install keeps a user-authored file that merely shares the legacy name", async () => {
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	const legacy = join(piDir, "vision-proxy.ts");
	writeFileSync(legacy, "console.log('user file');\n");
	await runIntegration("install", "pi");
	assert.equal(readFileSync(legacy, "utf8"), "console.log('user file');\n");
	reset();
});

test("uninstall also removes a marker-stamped legacy artifact", async () => {
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	const legacy = join(piDir, "vision-proxy.ts");
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\n`);
	writeFileSync(join(piDir, "vision-proxy_read.ts"), `__VP_VERSION__:${VERSION}\n`);
	const r = await runIntegration("uninstall", "pi");
	assert.equal(r.ok, true);
	assert.equal(existsSync(legacy), false);
	assert.equal(existsSync(join(piDir, "vision-proxy_read.ts")), false);
	reset();
});

test("uninstall of a legacy-only install removes the marker-stamped legacy artifact", async () => {
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	const legacy = join(piDir, "vision-proxy.ts");
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\n`);
	// Only the pre-migration artifact exists (new target absent): uninstall
	// must still clear it instead of early-returning "nothing to uninstall".
	const r = await runIntegration("uninstall", "pi");
	assert.equal(r.ok, true);
	assert.match(r.message, /uninstalled pi/);
	assert.equal(existsSync(legacy), false);
	// A user-authored legacy file is never removed or reported as uninstalled
	// (the install dir may have been cleaned up by the uninstall above).
	mkdirSync(piDir, { recursive: true });
	writeFileSync(legacy, "console.log('user file');\n");
	const r2 = await runIntegration("uninstall", "pi");
	assert.equal(r2.ok, true);
	assert.match(r2.message, /was not installed|nothing to uninstall/);
	assert.equal(existsSync(legacy), true);
	reset();
});

test("uninstall fails visibly when legacy cleanup cannot remove a stamped legacy file", {
	skip: !CAN_BLOCK_REMOVAL,
}, async () => {
	// POSIX only (CI runs ubuntu): a read-only install dir blocks rmSync on
	// the stamped legacy file, simulating the cleanup-failure state. With no
	// current target present, uninstall must fail instead of reporting
	// success while the legacy file keeps auto-loading pi hooks.
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	const legacy = join(piDir, "vision-proxy.ts");
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\n`);
	chmodSync(piDir, 0o555);
	try {
		const r = await runIntegration("uninstall", "pi");
		assert.equal(
			r.ok,
			false,
			"uninstall must fail when a stamped legacy survives on an auto-loading host",
		);
		assert.equal(r.code, 1);
		assert.match(r.message, /legacy artifact at .+vision-proxy\.ts/);
		assert.match(r.message, /delete it manually/);
		assert.equal(existsSync(legacy), true, "unremovable legacy file is left in place");
	} finally {
		chmodSync(piDir, 0o755);
		reset();
	}
});

test("uninstall of a hook agent warns about a surviving legacy script instead of failing", {
	skip: !CAN_BLOCK_REMOVAL,
}, async () => {
	const home = isolate();
	const hooksDir = join(home, ".claude", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const legacy = join(hooksDir, "vision-proxy.ts");
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\n`);
	chmodSync(hooksDir, 0o555);
	try {
		const r = await runIntegration("uninstall", "claude");
		// No config registration and no current target: the leftover legacy
		// script is inert on hook agents, so uninstall stays successful
		// with a warning.
		assert.equal(r.ok, true);
		assert.equal(r.code, 0);
		assert.match(r.message, /was not installed/);
		assert.match(r.message, /Warning: legacy artifact at .+vision-proxy\.ts/);
	} finally {
		chmodSync(hooksDir, 0o755);
		reset();
	}
});

test("install fails visibly when legacy cleanup cannot remove a stamped legacy file", {
	skip: !CAN_BLOCK_REMOVAL,
}, async () => {
	// POSIX only (CI runs ubuntu): a read-only install dir lets the install
	// rewrite the pre-existing target file but blocks rmSync on the legacy
	// one, simulating the cleanup-failure state CodeRabbit flagged.
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	const fresh = join(piDir, "vision-proxy_read.ts");
	const legacy = join(piDir, "vision-proxy.ts");
	writeFileSync(fresh, `__VP_VERSION__:${VERSION}\n`);
	writeFileSync(legacy, `__VP_VERSION__:0.0.9\n`);
	chmodSync(piDir, 0o555);
	try {
		const r = await runIntegration("install", "pi");
		assert.equal(
			r.ok,
			false,
			"install must fail when a stamped legacy survives on an auto-loading host",
		);
		assert.equal(r.code, 1);
		assert.match(r.message, /legacy artifact at .+vision-proxy\.ts/);
		assert.match(r.message, /delete it manually/);
		assert.equal(existsSync(legacy), true, "unremovable legacy file is left in place");
	} finally {
		chmodSync(piDir, 0o755);
		reset();
	}
});

test("status hints at a stale legacy artifact until re-installed", async () => {
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	writeFileSync(join(piDir, "vision-proxy.ts"), `__VP_VERSION__:0.0.9\n`);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(
		r.message,
		/legacy artifact at .+vision-proxy\.ts - re-run: vp integration install pi/,
	);
	// A legacy-only file-agent install is active (the dir auto-loads it), so
	// the summary must count it as installed and out of date, not as absent.
	assert.match(r.message, /1 of 1 integration\(s\) out of date/);
	reset();
});

test("status marks an installed agent out of date when a legacy artifact survives", async () => {
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	writeFileSync(join(piDir, "vision-proxy_read.ts"), `__VP_VERSION__:${VERSION}\n`);
	writeFileSync(join(piDir, "vision-proxy.ts"), `__VP_VERSION__:0.0.9\n`);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(
		r.message,
		/! pi\s+legacy artifact at .+vision-proxy\.ts - re-run: vp integration install pi/,
	);
	assert.match(r.message, /1 of 1 integration\(s\) out of date/);
	reset();
});

test("status counts a legacy-and-stale agent as out of date only once", async () => {
	isolate();
	const piDir = home_pi();
	mkdirSync(piDir, { recursive: true });
	writeFileSync(join(piDir, "vision-proxy_read.ts"), `__VP_VERSION__:0.0.9\n`);
	writeFileSync(join(piDir, "vision-proxy.ts"), `__VP_VERSION__:0.0.9\n`);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, /! pi\s+legacy artifact at/);
	assert.match(r.message, /! pi\s+0\.0\.9/);
	assert.match(r.message, /1 of 1 integration\(s\) out of date/);
	reset();
});

test("status reports a surviving legacy hook-agent script as inert, not out of date", async () => {
	const home = isolate();
	const hooksDir = join(home, ".claude", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const fresh = join(hooksDir, "vision-proxy_read.ts");
	writeFileSync(fresh, `__VP_VERSION__:${VERSION}\n`);
	writeFileSync(join(hooksDir, "vision-proxy.ts"), `__VP_VERSION__:0.0.9\n`);
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{ hooks: [{ type: "command", command: `npx tsx ${fresh}`, timeout: 30 }] },
				],
			},
		}),
	);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, /- claude\s+inert legacy artifact at .+vision-proxy\.ts/);
	assert.match(r.message, /all 1 integration\(s\) up to date/);
	reset();
});

test("status flags a legacy-only hook-agent registration for re-install, not inert", async () => {
	const home = isolate();
	const hooksDir = join(home, ".claude", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const legacyScript = join(hooksDir, "vision-proxy.ts");
	writeFileSync(legacyScript, `__VP_VERSION__:0.0.9\n`);
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{ hooks: [{ type: "command", command: `npx tsx ${legacyScript}`, timeout: 30 }] },
				],
			},
		}),
	);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	// No _read artifact is installed, so the legacy file is the live registered
	// hook - status must flag it for re-install, not call it inert (advising
	// manual deletion would break the user's hooks).
	assert.match(
		r.message,
		/! claude\s+legacy artifact at .+vision-proxy\.ts - re-run: vp integration install claude/,
	);
	assert.match(r.message, /out of date/);
	reset();
});

test("reinstall claude migrates a legacy-named registration and script", async () => {
	const home = isolate();
	const hooksDir = join(home, ".claude", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const legacyScript = join(hooksDir, "vision-proxy.ts");
	writeFileSync(legacyScript, `__VP_VERSION__:0.0.9\n`);
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{ hooks: [{ type: "command", command: `npx tsx ${legacyScript}`, timeout: 30 }] },
				],
			},
		}),
	);
	const r = await runIntegration("install", "claude");
	assert.equal(r.ok, true);
	assert.equal(existsSync(legacyScript), false, "legacy script must be removed on install");
	const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1, "install must not duplicate the registration");
	assert.match(cfg.hooks.UserPromptSubmit[0].hooks[0].command, /vision-proxy_read\.ts/);
	reset();
});

test("uninstall codex removes the script and registrations", async () => {
	const home = isolate();
	await runIntegration("install", "codex");
	assert.equal(existsSync(codexHookPath(home)), true);
	const r = await runIntegration("uninstall", "codex");
	assert.equal(r.ok, true);
	assert.equal(existsSync(codexHookPath(home)), false);
	const cfg = parseHooks(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
	assert.equal(cfg.hooks, undefined);
	reset();
});
