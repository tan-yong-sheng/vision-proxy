/**
 * Unit tests for `vp integration` install/show/list/uninstall.
 *
 * Exercises the generated Pi extension and the Claude Code / Codex hook
 * registrations against an isolated temp HOME so we never touch a real
 * ~/.claude, ~/.codex, or ~/.pi. Validates:
 *   - install pi writes a valid extension and cleans up an empty extensions dir
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
import { delimiter, join } from "node:path";
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
 * Execute the generated Pi extension with stubbed dependencies to verify it
 * conforms to the Pi extension public interface contract: a default export
 * function that registers an `analyze_image` tool whose `execute` handler
 * returns the standard AgentToolResult shape.
 */
async function assertValidPiExtension(source: string, home: string): Promise<void> {
	const dir = join(home, "ext-test");
	mkdirSync(dir, { recursive: true });

	// Redirect imports to local stubs so the generated extension can be loaded
	// and executed without real dependencies or subprocesses.
	const testSource = source.replace(/"node:child_process"/g, '"./mock-child-process.ts"');

	writeFileSync(join(dir, "vision-proxy.ts"), testSource);
	writeFileSync(
		join(dir, "mock-child-process.ts"),
		`let nextResult;
export function setNextResult(r) { nextResult = r; }
export function spawnSync(..._args) { return nextResult; }
`,
	);

	const mod = await import(join(dir, "vision-proxy.ts"));
	// Pi extension tools are invoked as execute(toolCallId, params, signal).
	const registered: Array<{
		name: string;
		execute: (toolCallId: string, params: unknown, signal?: unknown) => Promise<unknown>;
	}> = [];
	const mockPi = {
		registerTool: (tool: {
			name: string;
			execute: (toolCallId: string, params: unknown, signal?: unknown) => Promise<unknown>;
		}) => registered.push(tool),
	};

	assert.equal(
		typeof mod.default,
		"function",
		"generated extension must export a default setup function",
	);
	mod.default(mockPi);

	assert.equal(registered.length, 1, "setup must register exactly one tool");
	assert.equal(registered[0]!.name, "analyze_image", "registered tool name must be analyze_image");

	const mockCp = await import(join(dir, "mock-child-process.ts"));

	mockCp.setNextResult({
		status: 0,
		stdout: JSON.stringify({
			cacheHit: true,
			records: [{ hash: "abc", description: "an image description" }],
		}),
		stderr: "",
		error: undefined,
	});
	const result = await registered[0]!.execute("call-1", { paths: ["/tmp/img.png"] }, undefined);
	assert.ok(result, "execute must return a result");
	assert.ok(Array.isArray(result.content), "result.content must be an array");
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0]!.type, "text");
	assert.equal(result.content[0]!.text, "an image description");
	assert.ok(result.details, "result.details must be defined");
	assert.equal(result.details.cacheHit, true);
	assert.ok(Array.isArray(result.details.records));

	await assert.rejects(
		async () => registered[0]!.execute("call-2", { paths: [] }, undefined),
		/requires at least one image path/,
	);
}

test("install pi writes the vision-proxy extension file with valid source", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("install", "pi", dir);
	assert.equal(r.ok, true);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	const written = readFileSync(target, "utf8");
	await assertValidPiExtension(written, home);
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

test("install opencode writes the vision-proxy plugin file with valid source", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("install", "opencode", dir);
	assert.equal(r.ok, true);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	const written = readFileSync(target, "utf8");
	assert.match(written, /chat\.message/);
	assert.match(written, /tool\.execute\.before/);
	assert.match(written, /vp analyze/);
	assert.match(written, /__VP_VERSION__:0\.1\.2/);
	reset();
});

test("install opencode is idempotent (no error on re-install)", async () => {
	const home = isolate();
	const dir = installDir(home);
	const first = await runIntegration("install", "opencode", dir);
	assert.equal(first.ok, true);
	const second = await runIntegration("install", "opencode", dir);
	assert.equal(second.ok, true);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	reset();
});

test("uninstall opencode removes the file and cleans up empty plugins directory", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "opencode", dir);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	const r = await runIntegration("uninstall", "opencode", dir);
	assert.equal(r.ok, true);
	assert.equal(existsSync(target), false);
	assert.equal(existsSync(dir), false);
	reset();
});

test("show opencode prints plugin info without writing to disk", async () => {
	const _home = isolate();
	const r = await runIntegration("show", "opencode");
	assert.equal(r.ok, true);
	assert.match(r.message, /vision-proxy/);
	assert.match(r.message, /chat\.message/);
	assert.match(r.message, /tool\.execute\.before/);
	assert.match(r.message, /VP_MODEL/);
	assert.match(r.message, /VP_PROVIDER/);
	reset();
});

test("list shows opencode installed state", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "opencode", dir);
	const r = await runIntegration("list", "", dir);
	assert.match(r.message, /✓ opencode/);
	reset();
});

test("status reports opencode version from plugin file", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "opencode", dir);
	const r = await runIntegration("status", "", dir);
	assert.equal(r.ok, true);
	assert.match(r.message, new RegExp(`✓ opencode\\s+${VERSION.replace(/\./g, "\\.")}`));
	reset();
});

test("status flags stale opencode plugin version", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "opencode", dir);
	const target = join(dir, "vision-proxy.ts");
	writeFileSync(
		target,
		readFileSync(target, "utf8").replace(/__VP_VERSION__:[0-9.]+/, "__VP_VERSION__:0.0.9"),
	);
	const r = await runIntegration("status", "", dir);
	assert.equal(r.ok, true);
	assert.match(r.message, /! opencode\s+0\.0\.9/);
	assert.match(r.message, /out of date/);
	reset();
});
