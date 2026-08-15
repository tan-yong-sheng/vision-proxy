/**
 * Unit tests for `vp integration` install/show/uninstall.
 *
 * Exercises the Pi extension file generation against an isolated temp HOME so we
 * never touch a real ~/.pi directory. Validates:
 *   - install writes the Pi extension file with valid extension source
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
	const testSource = source
		.replace(/"node:child_process"/g, '"./mock-child-process.ts"')
		.replace(/"typebox"/g, '"./mock-typebox.ts"');

	writeFileSync(join(dir, "vision-proxy.ts"), testSource);
	writeFileSync(
		join(dir, "mock-typebox.ts"),
		`export const Type = {
\tObject: (props) => props,
\tArray: (item) => ({ type: "array", item }),
\tOptional: (schema) => ({ ...schema, optional: true }),
\tString: (opts) => ({ type: "string", opts }),
};
`,
	);
	writeFileSync(
		join(dir, "mock-child-process.ts"),
		`let nextResult;
export function setNextResult(r) { nextResult = r; }
export function spawnSync(..._args) { return nextResult; }
`,
	);

	const mod = await import(join(dir, "vision-proxy.ts"));
	const registered: Array<{ name: string; execute: Function }> = [];
	const mockPi = {
		registerTool: (tool: { name: string; execute: Function }) => registered.push(tool),
	};

	assert.equal(typeof mod.default, "function", "generated extension must export a default setup function");
	mod.default(mockPi);

	assert.equal(registered.length, 1, "setup must register exactly one tool");
	assert.equal(registered[0]!.name, "analyze_image", "registered tool name must be analyze_image");

	const mockCp = await import(join(dir, "mock-child-process.ts"));

	// Successful execution returns the expected AgentToolResult shape.
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

	// Empty paths are rejected with a clear error before any subprocess call.
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
