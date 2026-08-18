/**
 * Unit tests for `vp config` subcommands.
 *
 * Uses an isolated temp cwd so the project .vision-proxy.json is isolated from
 * the user config dir. Provider configuration is exercised via `configSet`
 * (writing `provider` into the project file) and `configValidate`.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { configGet, configInit, configSet, configValidate } from "./config.ts";

let cwd: string;
let prevHome: string | undefined;

beforeEach(async () => {
	cwd = await mkdtemp(path.join(os.tmpdir(), "vp-cfg-"));
	prevHome = process.env.HOME;
	process.env.HOME = cwd;
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
});

describe("configInit", () => {
	it("scaffolds a .vision-proxy.json with defaults", async () => {
		const r = await configInit(cwd);
		assert.equal(r.ok, true);
		const raw = await readFile(path.join(cwd, ".vision-proxy.json"), "utf8");
		const parsed = JSON.parse(raw);
		assert.equal(typeof parsed.provider, "string");
		assert.equal(typeof parsed.modelId, "string");
	});

	it("refuses to overwrite an existing config", async () => {
		await configInit(cwd);
		const r = await configInit(cwd);
		assert.equal(r.ok, false);
		assert.equal(r.code, 1);
	});
});

describe("configGet", () => {
	it("resolves from built-in defaults when no file exists", async () => {
		const r = await configGet({ cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(r.ok, true);
		assert.match(r.message, /resolved from: defaults/);
		const cfg = JSON.parse(r.message.split("\n").slice(1).join("\n"));
		assert.equal(typeof cfg.provider, "string");
	});

	it("layers an explicit --config file over defaults", async () => {
		const explicit = path.join(cwd, "explicit.json");
		await writeFile(explicit, JSON.stringify({ provider: "openai", modelId: "gpt-4o" }), "utf8");
		const r = await configGet({ configPath: explicit, cwd, env: {} as NodeJS.ProcessEnv });
		assert.match(r.message, /resolved from: explicit:/);
		const cfg = JSON.parse(r.message.split("\n").slice(1).join("\n"));
		assert.equal(cfg.provider, "openai");
		assert.equal(cfg.modelId, "gpt-4o");
	});

	it("redacts apiKey in printed output", async () => {
		const explicit = path.join(cwd, "explicit.json");
		await writeFile(
			explicit,
			JSON.stringify({ provider: "openai", modelId: "gpt-4o", apiKey: "secret-key" }),
			"utf8",
		);
		const r = await configGet({ configPath: explicit, cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(r.ok, true);
		assert.doesNotMatch(r.message, /secret-key/);
		assert.match(r.message, /"apiKey": "\*\*\*"/);
	});
});

describe("configSet", () => {
	it("sets a known string key in the project file", async () => {
		const r = await configSet("provider", "openai", cwd);
		assert.equal(r.ok, true);
		const raw = await readFile(path.join(cwd, ".vision-proxy.json"), "utf8");
		assert.equal(JSON.parse(raw).provider, "openai");
	});

	it("coerces numeric keys", async () => {
		await configSet("cacheSize", "120", cwd);
		const raw = await readFile(path.join(cwd, ".vision-proxy.json"), "utf8");
		assert.equal(JSON.parse(raw).cacheSize, 120);
	});

	it("rejects an unknown key", async () => {
		const r = await configSet("notAKey", "x", cwd);
		assert.equal(r.ok, false);
		assert.equal(r.code, 1);
	});

	it("sets baseUrl as a plain string", async () => {
		const r = await configSet("baseUrl", "http://localhost:8000/v1", cwd);
		assert.equal(r.ok, true);
		const raw = await readFile(path.join(cwd, ".vision-proxy.json"), "utf8");
		assert.equal(JSON.parse(raw).baseUrl, "http://localhost:8000/v1");
	});

	it("sets apiKey as a plain string", async () => {
		const r = await configSet("apiKey", "my-secret-key", cwd);
		assert.equal(r.ok, true);
		const raw = await readFile(path.join(cwd, ".vision-proxy.json"), "utf8");
		assert.equal(JSON.parse(raw).apiKey, "my-secret-key");
	});
});

describe("configValidate", () => {
	it("reports missing key for the default provider without an env key", async () => {
		const r = await configValidate({ cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(r.ok, true);
		assert.match(r.message, /missing key/);
	});

	it("reports reachable when the key is present", async () => {
		const env = { ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv;
		const r = await configValidate({ cwd, env });
		assert.equal(r.ok, true);
		assert.match(r.message, /reachable/);
	});

	it("reports reachable when only config.apiKey is set", async () => {
		await configSet("provider", "openai", cwd);
		await configSet("apiKey", "cfg-secret-key", cwd);
		const r = await configValidate({ cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(r.ok, true);
		assert.match(r.message, /reachable/);
	});
});
