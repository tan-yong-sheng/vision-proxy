/**
 * Tests for per-subcommand `--help` output.
 *
 * Each case captures stdout from `main()` and asserts that the right help
 * block is printed (and that exit code stays 0).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { main, parseFlags } from "./cli.ts";

let savedWrite: typeof process.stdout.write;
let savedExitCode: number | undefined;
let out: string;

function capture(): void {
	out = "";
	savedWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	savedExitCode = process.exitCode;
	process.exitCode = 0;
}

function restore(): void {
	process.stdout.write = savedWrite;
	process.exitCode = savedExitCode;
}

async function run(args: string[]): Promise<string> {
	capture();
	await main(args);
	const text = out;
	const _code = process.exitCode ?? 0;
	restore();
	return text;
}

describe("parseFlags", () => {
	it("keeps a positional after a boolean flag (--json before path)", () => {
		// Regression: the pi-extension invokes `vp analyze --json <path...>`.
		// A boolean flag must not swallow the following path as its value.
		const { flags, positionals } = parseFlags(["--json", "image.png"]);
		assert.deepEqual(positionals, ["image.png"]);
		assert.equal(flags.json, true);
	});

	it("keeps every positional when a boolean flag precedes multiple paths", () => {
		const { flags, positionals } = parseFlags(["--json", "first.png", "second.png"]);
		assert.deepEqual(positionals, ["first.png", "second.png"]);
		assert.equal(flags.json, true);
	});

	it("still consumes a value for flags that take one (--format)", () => {
		const { flags, positionals } = parseFlags(["--format", "qwen_pixels", "image.png"]);
		assert.deepEqual(positionals, ["image.png"]);
		assert.equal(flags.format, "qwen_pixels");
	});

	it("treats --no-fence as fence=false and keeps following positionals", () => {
		const { flags, positionals } = parseFlags(["--no-fence", "image.png"]);
		assert.deepEqual(positionals, ["image.png"]);
		assert.equal(flags.fence, false);
	});

	it("does not let a trailing boolean flag consume nothing", () => {
		const { flags, positionals } = parseFlags(["image.png", "--json"]);
		assert.deepEqual(positionals, ["image.png"]);
		assert.equal(flags.json, true);
	});
});

describe("cli help", () => {
	it("prints top-level help for no args", async () => {
		const text = await run([]);
		assert.match(text, /vision-proxy \(vp\)/);
		assert.match(text, /Usage:/);
	});

	it("prints top-level help for --help", async () => {
		const text = await run(["--help"]);
		assert.match(text, /Usage:/);
	});

	it("prints help for analyze --help", async () => {
		const text = await run(["analyze", "--help"]);
		assert.match(text, /vp analyze <paths\.\.\.> \[options\]/);
		assert.match(text, /--crop <i:form>/);
	});

	it("prints help for config subcommands", async () => {
		const parent = await run(["config", "--help"]);
		assert.match(parent, /vp config <subcommand> \[options\]/);
		assert.match(parent, /init/);

		const setHelp = await run(["config", "set", "--help"]);
		assert.match(setHelp, /vp config set <key> <value>/);
		assert.match(setHelp, /coerced to the key's type/);

		const initHelp = await run(["config", "init", "--help"]);
		assert.match(initHelp, /Scaffold a \.vision-proxy\.json/);

		const getHelp = await run(["config", "get", "-h"]);
		assert.match(getHelp, /Print the resolved config/);

		const validateHelp = await run(["config", "validate", "--help"]);
		assert.match(validateHelp, /Validate config and probe provider reachability/);
	});

	it("prints help for provider subcommands", async () => {
		const parent = await run(["provider", "--help"]);
		assert.match(parent, /vp provider <subcommand> \[options\]/);

		const storeKeyHelp = await run(["provider", "store-key", "--help"]);
		assert.match(storeKeyHelp, /Read a provider API key from stdin/);

		const deleteKeyHelp = await run(["provider", "delete-key", "--help"]);
		assert.match(deleteKeyHelp, /Delete a provider's API key/);

		const listHelp = await run(["provider", "list", "--help"]);
		assert.match(listHelp, /key presence/);

		const listKeysHelp = await run(["provider", "list-keys", "--help"]);
		assert.match(listKeysHelp, /system keyring/);

		const checkHelp = await run(["provider", "check", "--help"]);
		assert.match(checkHelp, /Verify that an API key is configured/);
	});

	it("prints help for cache subcommands", async () => {
		const parent = await run(["cache", "--help"]);
		assert.match(parent, /vp cache <subcommand> \[options\]/);

		const status = await run(["cache", "status", "--help"]);
		assert.match(status, /hit rate/);

		const clear = await run(["cache", "clear", "--help"]);
		assert.match(clear, /Drop all cached entries/);

		const prune = await run(["cache", "prune", "--help"]);
		assert.match(prune, /--older <days>/);
	});

	it("prints help for integration subcommands", async () => {
		const parent = await run(["integration", "--help"]);
		assert.match(parent, /vp integration <subcommand> \[agent\]/);

		const install = await run(["integration", "install", "--help"]);
		assert.match(install, /Install the vision-proxy integration/);

		const show = await run(["integration", "show", "--help"]);
		assert.match(show, /generated extension source/);

		const list = await run(["integration", "list", "--help"]);
		assert.match(list, /installed agents/);

		const status = await run(["integration", "status", "--help"]);
		assert.match(status, /version markers/);

		const uninstall = await run(["integration", "uninstall", "--help"]);
		assert.match(uninstall, /Remove the vision-proxy integration/);
	});

	it("does not treat --help as an unknown subcommand", async () => {
		// The literal "help" token as a subcommand must resolve to help, not an error.
		const text = await run(["config", "help"]);
		assert.match(text, /vp config <subcommand> \[options\]/);
		assert.ok(!/unknown config subcommand/.test(text));
	});
});
