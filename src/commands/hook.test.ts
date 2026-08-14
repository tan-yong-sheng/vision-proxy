/**
 * Unit tests for `vp hook` install/show/list/uninstall.
 *
 * Exercises the agent-config editing logic against an isolated temp HOME so we
 * never touch a real ~/.claude or ~/.codex. Validates:
 *   - install writes the correct UserPromptSubmit block for each agent
 *   - list reflects installed state
 *   - uninstall removes only our block (idempotent, leaves others intact)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../commands/hook.ts";

const ORIG_HOME = process.env.HOME;

function isolate(): string {
	const home = mkdtempSync(join(tmpdir(), "vp-hook-test-"));
	process.env.HOME = home;
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(home, ".codex"), { recursive: true });
	return home;
}

function reset() {
	if (ORIG_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIG_HOME;
}

function shimDir(home: string): string {
	return join(home, "shims");
}

test("install claude-code writes UserPromptSubmit into settings.json", async () => {
	const home = isolate();
	const r = await runHook("install", "claude-code", shimDir(home));
	assert.equal(r.ok, true);
	const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	const groups = cfg.hooks.UserPromptSubmit;
	assert.equal(Array.isArray(groups) && groups.length, 1);
	const cmd = groups[0].hooks[0].command;
	assert.match(cmd, /claude-code-vision-proxy-user-prompt-submit\.mjs$/);
	assert.equal(groups[0].hooks[0].timeout, 30);
	reset();
});

test("install codex appends a [[UserPromptSubmit]] block with additionalContextLimit", async () => {
	const home = isolate();
	const r = await runHook("install", "codex", shimDir(home));
	assert.equal(r.ok, true);
	const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
	assert.match(toml, /\[\[UserPromptSubmit\]\]/);
	assert.match(toml, /command = "node .*codex-vision-proxy-user-prompt-submit\.mjs"/);
	assert.match(toml, /additionalContextLimit = 4096/);
	reset();
});

test("install is idempotent (no duplicate blocks)", async () => {
	const home = isolate();
	await runHook("install", "claude-code", shimDir(home));
	const first = await runHook("install", "claude-code", shimDir(home));
	assert.equal(first.ok, true);
	const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	reset();
});

test("list shows installed agents", async () => {
	const home = isolate();
	await runHook("install", "claude-code", shimDir(home));
	await runHook("install", "codex", shimDir(home));
	const r = await runHook("list", "");
	assert.match(r.message, /✓ claude-code/);
	assert.match(r.message, /✓ codex/);
	reset();
});

test("uninstall removes only the vision-proxy block and leaves others", async () => {
	const home = isolate();
	const installDir = shimDir(home);
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{ type: "command", command: "node /some/other-hook.mjs", timeout: 10 },
						],
					},
				],
			},
		}),
	);
	await runHook("install", "claude-code", installDir);
	let cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 2);
	const r = await runHook("uninstall", "claude-code", installDir);
	assert.equal(r.ok, true);
	cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.match(cfg.hooks.UserPromptSubmit[0].hooks[0].command, /other-hook\.mjs$/);
	reset();
});

test("uninstall of a never-installed agent reports nothing-to-do", async () => {
	isolate();
	const r = await runHook("uninstall", "claude-code");
	assert.equal(r.ok, true);
	assert.match(r.message, /was not installed|absent/);
	reset();
});

test("unknown agent rejected", async () => {
	isolate();
	const r = await runHook("install", "vim");
	assert.equal(r.ok, false);
	assert.match(r.message, /unknown agent/);
	reset();
});
