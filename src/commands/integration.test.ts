/**
 * Unit tests for `vp integration` install/show/list/uninstall.
 *
 * Exercises the generated Pi extension and the Claude Code / Codex hook shims
 * against an isolated temp HOME so we never touch a real ~/.claude, ~/.codex, or
 * ~/.pi. Validates:
 *   - install pi writes a valid extension and cleans up an empty extensions dir
 *   - install claude-code/codex writes the shim + wires the agent config
 *   - show prints the generated source without touching disk
 *   - list reflects installed state across agents
 *   - uninstall removes only our block (idempotent, leaves others intact)
 *   - unknown agent/subcommand is rejected
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runIntegration } from "../commands/integration.ts";

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

/** Pi's default extensions dir under the isolated HOME (`~/.pi/agent/extensions`). */
function home_pi(): string {
	return join(process.env.HOME!, ".pi", "agent", "extensions");
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

test("install claude-code writes the shim and wires settings.json", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("install", "claude-code", dir);
	assert.equal(r.ok, true);
	const shim = join(dir, "claude-code-vision-proxy-user-prompt-submit.mjs");
	assert.equal(existsSync(shim), true);
	assert.equal(existsSync(join(dir, "shared.mjs")), true);
	const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	const groups = cfg.hooks.UserPromptSubmit;
	assert.equal(Array.isArray(groups) && groups.length, 1);
	const cmd = groups[0].hooks[0].command;
	assert.match(cmd, /claude-code-vision-proxy-user-prompt-submit\.mjs$/);
	assert.equal(groups[0].hooks[0].timeout, 30);
	reset();
});

test("install codex writes the shim and appends a [[UserPromptSubmit]] block", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("install", "codex", dir);
	assert.equal(r.ok, true);
	const shim = join(dir, "codex-vision-proxy-user-prompt-submit.mjs");
	assert.equal(existsSync(shim), true);
	const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
	assert.match(toml, /\[\[UserPromptSubmit\]\]/);
	assert.match(toml, /command = "node .*codex-vision-proxy-user-prompt-submit\.mjs"/);
	assert.match(toml, /additionalContextLimit = 4096/);
	reset();
});

test("codex status reports not installed when marker is outside a UserPromptSubmit block", async () => {
	const home = isolate();
	const dir = installDir(home);
	mkdirSync(join(home, ".codex"), { recursive: true });
	// Stale config: "vision-proxy" appears in a comment but not inside a block.
	writeFileSync(
		join(home, ".codex", "config.toml"),
		'# old vision-proxy hook\n[[UserPromptSubmit]]\n\n[[UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "node /some/other/hook.mjs"\n',
	);
	const status = await runIntegration("status", "");
	assert.equal(status.ok, true);
	assert.match(status.message, /✗ codex\s+not installed/);
	const uninstall = await runIntegration("uninstall", "codex", dir);
	assert.equal(uninstall.ok, true);
	assert.match(uninstall.message, /nothing to uninstall|was not installed/);
	reset();
});

test("codex uninstall removes a valid block when the shim file is missing", async () => {
	const home = isolate();
	const dir = installDir(home);
	mkdirSync(join(home, ".codex"), { recursive: true });
	const target = join(dir, "codex-vision-proxy-user-prompt-submit.mjs");
	const toml = `\n[[UserPromptSubmit]]\n\n[[UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "node ${target.replace(/\\/g, "/")}"\ntimeout = 30\nadditionalContextLimit = 4096\n`;
	writeFileSync(join(home, ".codex", "config.toml"), toml);
	const status = await runIntegration("status", "");
	assert.equal(status.ok, true);
	assert.match(status.message, /✓ codex\s+installed \(version unknown\)/);
	const uninstall = await runIntegration("uninstall", "codex", dir);
	assert.equal(uninstall.ok, true);
	assert.match(uninstall.message, /uninstalled codex/);
	reset();
});

test("install claude-code ships shared.mjs next to the shim and the import resolves", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("install", "claude-code", dir);
	assert.equal(r.ok, true);
	const _shim = join(dir, "claude-code-vision-proxy-user-prompt-submit.mjs");
	const shared = join(dir, "shared.mjs");
	assert.equal(existsSync(shared), true, "shared.mjs must land next to the installed shim");
	// Regression: the installed shim does `import "./shared.mjs"`, so the import
	// must resolve. If shared.mjs were missing this throws ERR_MODULE_NOT_FOUND.
	await import(shared);
	// The install-time placeholder must have been rewritten to an absolute path
	// (the real `vp` binary), not left as the literal token.
	const sharedText = readFileSync(shared, "utf8");
	assert.equal(
		sharedText.includes("__VP_PATH__PLACEHOLDER__"),
		false,
		"placeholder must be rewritten to a real path",
	);
	assert.match(
		sharedText,
		/const VP_BIN_PATH = "\/.+/,
		"placeholder rewritten to an absolute path",
	);
	reset();
});

test("install is idempotent (no duplicate blocks) for claude-code", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "claude-code", dir);
	const first = await runIntegration("install", "claude-code", dir);
	assert.equal(first.ok, true);
	const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	reset();
});

test("show pi prints the extension source without writing to disk", async () => {
	const home = isolate();
	const r = await runIntegration("show", "pi");
	assert.equal(r.ok, true);
	assert.match(r.message, /analyze_image/);
	assert.equal(existsSync(join(home, "ext", "vision-proxy.ts")), false);
	reset();
});

test("show claude-code prints the generated shim without writing to disk", async () => {
	isolate();
	const r = await runIntegration("show", "claude-code");
	assert.equal(r.ok, true);
	assert.match(r.message, /UserPromptSubmit/);
	assert.match(r.message, /vision-proxy/);
	reset();
});

test("list shows installed state across agents", async () => {
	const home = isolate();
	const dir = installDir(home);
	await runIntegration("install", "claude-code", dir);
	await runIntegration("install", "codex", dir);
	// pi uses its default ~/.pi location, not the test installDir.
	await runIntegration("install", "pi");
	const r = await runIntegration("list", "");
	assert.match(r.message, /✓ claude-code/);
	assert.match(r.message, /✓ codex/);
	assert.match(r.message, /✓ pi/);
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
	// Regression: pi has no host config, so the message must key off file
	// deletion, not a config-removal flag that never fires for pi.
	assert.match(r.message, /^uninstalled pi integration/);
	assert.equal(existsSync(target), false);
	reset();
});

test("uninstall claude-code removes only the vision-proxy block and leaves others", async () => {
	const home = isolate();
	const dir = installDir(home);
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [{ type: "command", command: "node /some/other-hook.mjs", timeout: 10 }],
					},
				],
			},
		}),
	);
	await runIntegration("install", "claude-code", dir);
	let cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 2);
	const r = await runIntegration("uninstall", "claude-code", dir);
	assert.equal(r.ok, true);
	cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.match(cfg.hooks.UserPromptSubmit[0].hooks[0].command, /other-hook\.mjs$/);
	reset();
});

test("uninstall claude-code keeps shared.mjs when codex shim still imports it", async () => {
	const home = isolate();
	const dir = installDir(home);
	// Both hook agents co-locate their shim and the shared sidecar in `dir`.
	await runIntegration("install", "claude-code", dir);
	await runIntegration("install", "codex", dir);
	assert.equal(existsSync(join(dir, "shared.mjs")), true);
	const r = await runIntegration("uninstall", "claude-code", dir);
	assert.equal(r.ok, true);
	// The codex shim still imports ./shared.mjs, so the sidecar must survive.
	assert.equal(
		existsSync(join(dir, "shared.mjs")),
		true,
		"shared.mjs must remain while another hook shim still uses it",
	);
	assert.equal(existsSync(join(dir, "codex-vision-proxy-user-prompt-submit.mjs")), true);
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
	assert.match(r.message, /vp 0\.1\.0/);
	assert.match(r.message, /✓ pi\s+0\.1\.0/);
	assert.match(r.message, /all \d+ integration\(s\) up to date/);
	reset();
});

test("status flags an integration whose embedded version marker is stale", async () => {
	isolate();
	await runIntegration("install", "pi");
	// Backdate the version marker baked into the generated Pi extension.
	const ext = join(home_pi(), "vision-proxy.ts");
	writeFileSync(
		ext,
		readFileSync(ext, "utf8").replace(/__VP_VERSION__:[0-9.]+/, "__VP_VERSION__:0.0.9"),
	);
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, /! pi\s+0\.0\.9.*installed vp is 0\.1\.0/);
	assert.match(r.message, /out of date/);
	reset();
});

test("status flags an installed integration with no version marker as outdated", async () => {
	isolate();
	await runIntegration("install", "pi");
	const ext = join(home_pi(), "vision-proxy.ts");
	writeFileSync(ext, readFileSync(ext, "utf8").replace(/__VP_VERSION__:[0-9.]+/, ""));
	const r = await runIntegration("status", "");
	assert.equal(r.ok, true);
	assert.match(r.message, /version unknown/);
	assert.match(r.message, /out of date/);
	reset();
});
