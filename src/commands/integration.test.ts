/**
 * Unit tests for `vp integration` install/show/uninstall.
 *
 * Exercises the Pi extension file generation against an isolated temp HOME so we
 * never touch a real ~/.pi directory. Validates:
 *   - install writes the Pi extension file with the embedded source
 *   - show prints the extension source without touching disk
 *   - uninstall removes the file and cleans up an empty extensions directory
 *   - unknown agent is rejected
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegration } from "../commands/integration.ts";
import { PI_EXTENSION_SOURCE } from "../pi-extension.ts";

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

test("install pi writes the vision-proxy extension file with embedded source", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("install", "pi", dir);
	assert.equal(r.ok, true);
	const target = join(dir, "vision-proxy.ts");
	assert.equal(existsSync(target), true);
	assert.equal(readFileSync(target, "utf8"), PI_EXTENSION_SOURCE);
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

test("show pi prints the extension source without writing to disk", async () => {
	const home = isolate();
	const r = await runIntegration("show", "pi");
	assert.equal(r.ok, true);
	assert.match(r.message, /analyze_image/);
	// Nothing should be written by `show`.
	assert.equal(existsSync(join(home, "ext", "vision-proxy.ts")), false);
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
	// The extensions directory itself should be removed when left empty.
	assert.equal(existsSync(dir), false);
	reset();
});

test("uninstall pi of a never-installed agent reports nothing-to-do", async () => {
	const home = isolate();
	const dir = installDir(home);
	const r = await runIntegration("uninstall", "pi", dir);
	assert.equal(r.ok, true);
	assert.match(r.message, /nothing to uninstall|absent/);
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
	// Directory kept because it still holds another file.
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
