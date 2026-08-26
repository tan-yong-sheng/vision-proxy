/**
 * Unit tests for `vp integration` install/show/list/uninstall.
 *
 * Exercises the generated Pi extension and the Claude Code / Codex hook
 * registrations against an isolated temp HOME so we never touch a real
 * ~/.claude, ~/.codex, or ~/.pi. Validates:
 *   - install pi writes an executable extension: its input handler describes
 *     attached/referenced images without altering the user prompt text,
 *     before_agent_start injects the description into the system prompt once,
 *     and tool_result replaces image reads
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
 * registering input, before_agent_start, and tool_result handlers (no tools).
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
	for (const required of ["input", "before_agent_start", "tool_result"]) {
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

test("pi extension input handler describes attached and referenced images without altering the prompt", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "pi", dir);
	const written = readFileSync(join(dir, "vision-proxy.ts"), "utf8");
	const { events, dir: testDir, calls, setNextResult } = await loadPiExtension(written, home);
	process.env.VP_MODE = "always";
	const imagePath = fakeImage(testDir, "sub", "photo.jpeg");
	const b64 = Buffer.from("fakepng").toString("base64");
	setNextResult({ status: 0, stdout: "@@FENCE red square@@" });

	const result = (await events.input[0]({
		type: "input",
		text: `look at ${imagePath} please`,
		images: [{ type: "image", data: b64, mimeType: "image/png" }],
	})) as { action: string; text: string; images: string[] };

	assert.equal(result.action, "transform");
	// The referenced path is preserved in the user prompt (parity with Claude
	// Code / Codex, which cannot rewrite the submission).
	assert.equal(result.text.includes(imagePath), true);
	assert.equal(result.text.includes("look at"), true);
	assert.equal(result.text.includes("please"), true);
	// ...and attached image bytes are dropped entirely.
	assert.equal(result.images.length, 0);
	// One analyze invocation covering the temp copy of the attachment plus the
	// referenced file (the config-get probe is a separate call).
	const analyzeCalls = calls.filter(([, args]) => args[0] === "analyze");
	assert.equal(analyzeCalls.length, 1);
	const analyzed = analyzeCalls[0]![1];
	assert.equal(analyzed[0], "analyze");
	assert.ok(analyzed.includes(imagePath));
	// The attachment is analyzed via a temp copy (a path outside the test dir).
	assert.ok(analyzed.some((a) => a.startsWith(tmpdir()) && a !== imagePath));
	reset();
});

test("pi extension injects the description into the system prompt exactly once", async () => {
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
	const transformed = (await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [],
	})) as any;
	assert.equal(transformed.action, "transform");

	const first = await events.before_agent_start[0]({
		type: "before_agent_start",
		prompt: transformed.text,
		systemPrompt: "BASE",
	});
	// The description is injected once into the system prompt (wrapped with the
	// "do not Read image files" instruction, mirroring Claude Code / Codex
	// additionalContext), and the user prompt text is untouched.
	assert.match((first as any).systemPrompt, /^BASE\n\n/);
	assert.match((first as any).systemPrompt, /Do not use the Read tool on image files/);
	assert.match((first as any).systemPrompt, /@@FENCE desc@@/);
	assert.equal(transformed.text, `see ${imagePath}`);
	// The stash is consumed: a second agent start in the same session is clean.
	const second = await events.before_agent_start[0]({
		type: "before_agent_start",
		prompt: "x",
		systemPrompt: "BASE",
	});
	assert.equal(second, undefined);
	reset();
});

test("pi extension embeds the description in the text for queued streaming prompts and does not leak the stash", async () => {
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

	// Queued streaming prompt: input fires with streamingBehavior set, but
	// before_agent_start is not emitted for queued messages.
	const transformed = (await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [],
		streamingBehavior: "steer",
	})) as { action: string; text: string; images: unknown[] };
	assert.equal(transformed.action, "transform");
	assert.equal(transformed.text.includes("see "), true, "user text survives");
	assert.equal(transformed.text.includes(imagePath), true, "image path is preserved");
	assert.match(transformed.text, /@@FENCE queued desc@@/);
	assert.match(transformed.text, /Do not use the Read tool on image files/);

	// The stash must remain empty: a subsequent idle prompt that returns
	// undefined from its own input handler must not see the queued turn's
	// description injected into its system prompt.
	const idle = await events.input[0]({
		type: "input",
		text: "follow-up text only, no images",
		images: [],
	});
	assert.equal(idle, undefined);
	const nextStart = await events.before_agent_start[0]({
		type: "before_agent_start",
		prompt: "follow-up text only, no images",
		systemPrompt: "BASE",
	});
	assert.equal(nextStart, undefined, "stale queued description must not leak into the next prompt");
	reset();
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

	// vp exits non-zero -> no transform, no stash.
	process.env.VP_MODE = "always";
	setNextResult({ status: 1, stdout: "" });
	const failed = await events.input[0]({ type: "input", text: `see ${imagePath}`, images: [] });
	assert.equal(failed, undefined);

	// mode off -> no-op even when analysis would succeed.
	process.env.VP_MODE = "off";
	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });
	const disabled = await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [{ type: "image", data: b64, mimeType: "image/png" }],
	});
	assert.equal(disabled, undefined);
	delete process.env.VP_MODE;
	reset();
});

test("pi extension passes through attachments it cannot analyze", async () => {
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

	setNextResult({ status: 0, stdout: "@@FENCE desc@@" });
	const result = (await events.input[0]({
		type: "input",
		text: `see ${imagePath}`,
		images: [unsupported],
	})) as { action: string; text: string; images: unknown[] };
	assert.equal(result.action, "transform");
	// The referenced path is preserved and described (not stripped)...
	assert.equal(result.text.includes(imagePath), true);
	// ...and the un-analyzable attachment survives instead of being dropped.
	assert.equal(result.images.length, 1);
	reset();
});

test("pi extension replaces read results on image files only", async () => {
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
