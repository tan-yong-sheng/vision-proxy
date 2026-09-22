/**
 * Tests for per-subcommand `--help` output.
 *
 * Each case captures stdout from `main()` and asserts that the right help
 * block is printed (and that exit code stays 0).
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main, parseFlags } from "./cli.ts";
import { loadUpdateCache, saveUpdateCache } from "./commands/update.ts";
import { VERSION } from "./version.ts";

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
		assert.match(parent, /show \[provider\]/);

		const setHelp = await run(["config", "set", "--help"]);
		assert.match(setHelp, /vp config set <key> <value>/);
		assert.match(setHelp, /coerced to the key's type/);

		const initHelp = await run(["config", "init", "--help"]);
		assert.match(initHelp, /Scaffold a \.vision-proxy\.json/);

		const getHelp = await run(["config", "get", "-h"]);
		assert.match(getHelp, /Print the resolved config/);

		const showHelp = await run(["config", "show", "--help"]);
		assert.match(showHelp, /vp config show \[provider\]/);

		const validateHelp = await run(["config", "validate", "--help"]);
		assert.match(validateHelp, /Validate config and check provider key presence/);
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

		const testHelp = await run(["provider", "test", "--help"]);
		assert.match(testHelp, /live text \+ vision connectivity probe/);
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
		assert.match(show, /hook command/);

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

describe("cli update-notifier suppression", () => {
	let dir: string;
	let prevCacheDir: string | undefined;
	let prevNoNotifier: string | undefined;
	let prevCI: string | undefined;
	let prevArgv1: string | undefined;
	let isTTYDescriptor: PropertyDescriptor | undefined;
	let savedStdoutWrite: typeof process.stdout.write;
	let savedStderrWrite: typeof process.stderr.write;
	let savedCode: number | undefined;
	let nOut: string;
	let nErr: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "vp-cli-notifier-"));
		prevCacheDir = process.env.VP_CACHE_DIR;
		process.env.VP_CACHE_DIR = dir;
		prevNoNotifier = process.env.VP_NO_UPDATE_NOTIFIER;
		delete process.env.VP_NO_UPDATE_NOTIFIER;
		prevCI = process.env.CI;
		delete process.env.CI;
		// Point the notifier's detached spawn at a missing entry so no real
		// child can be launched even if suppression regresses.
		prevArgv1 = process.argv[1];
		process.argv[1] = "";
		// Force the TTY branch: stderr is not a TTY under test runners, so
		// without this the banner would never print and the assertions
		// below would be vacuous.
		isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
		Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
		// Seed a fresh cache advertising a newer release, so an unsuppressed
		// notifier prints the banner. Freshness also avoids the spawn path.
		saveUpdateCache(
			{ checked_at: new Date().toISOString(), latest_version: "v99.0.0" },
			{ cacheDir: dir },
		);
		nOut = "";
		nErr = "";
		savedStdoutWrite = process.stdout.write.bind(process.stdout);
		savedStderrWrite = process.stderr.write.bind(process.stderr);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			nOut += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			nErr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stderr.write;
		savedCode = process.exitCode;
		process.exitCode = 0;
	});

	afterEach(async () => {
		process.stdout.write = savedStdoutWrite;
		process.stderr.write = savedStderrWrite;
		process.exitCode = savedCode;
		if (isTTYDescriptor) Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor);
		else delete (process.stderr as { isTTY?: boolean }).isTTY;
		if (prevArgv1 === undefined) delete process.argv[1];
		else process.argv[1] = prevArgv1;
		if (prevCacheDir === undefined) delete process.env.VP_CACHE_DIR;
		else process.env.VP_CACHE_DIR = prevCacheDir;
		if (prevNoNotifier === undefined) delete process.env.VP_NO_UPDATE_NOTIFIER;
		else process.env.VP_NO_UPDATE_NOTIFIER = prevNoNotifier;
		if (prevCI === undefined) delete process.env.CI;
		else process.env.CI = prevCI;
		await rm(dir, { recursive: true, force: true });
	});

	it("prints the banner when nothing suppresses it (control)", async () => {
		await main(["version"]);
		assert.match(nOut, new RegExp(VERSION.replace(/[.]/g, "[.]")));
		assert.match(nErr, /new version of vision-proxy/);
		assert.equal(process.exitCode ?? 0, 0);
	});

	it("suppresses the notifier for a first-token --json invocation", async () => {
		// Regression: main scanned argv.slice(1), dropping argv[0] before
		// the suppression check, so `main(["--json", ...])` printed the
		// banner on stderr. argv already excludes the binary name, so the
		// whole argv must be scanned.
		await main(["--json", "version"]);
		assert.ok(!/new version of vision-proxy/.test(nErr), `stderr leaked banner: ${nErr}`);
		// Dispatch is unchanged: "--json" is still not a command.
		assert.match(nErr, /unknown command "--json"/);
		assert.equal(process.exitCode ?? 0, 1);
		// The seeded cache is untouched: no refresh, no rewrite.
		assert.equal(loadUpdateCache({ cacheDir: dir })?.latest_version, "v99.0.0");
	});

	it("suppresses the notifier for --background-check", async () => {
		await main(["update", "--background-check"]);
		assert.ok(!/new version of vision-proxy/.test(nErr), `stderr leaked banner: ${nErr}`);
		assert.equal(nOut, "");
		assert.equal(process.exitCode ?? 0, 0);
	});

	it("suppresses the notifier for a first-token --background-check", async () => {
		await main(["--background-check"]);
		assert.ok(!/new version of vision-proxy/.test(nErr), `stderr leaked banner: ${nErr}`);
		assert.match(nErr, /unknown command "--background-check"/);
		assert.equal(process.exitCode ?? 0, 1);
	});
});
