/**
 * Unit tests for `vp config` subcommands.
 *
 * Uses an isolated temp cwd so the project .vision-proxy.json is isolated from
 * the user config dir. Provider configuration is exercised via `configSet`
 * (writing `provider` into the project file) and `configValidate`.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configInit, configGet, configSet, configValidate } from "./config.ts";

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

	it("accepts a JSON object for baseURLs", async () => {
		const r = await configSet("baseURLs", '{"openai":"http://localhost:8000/v1"}', cwd);
		assert.equal(r.ok, true);
		const raw = await readFile(path.join(cwd, ".vision-proxy.json"), "utf8");
		assert.deepEqual(JSON.parse(raw).baseURLs, { openai: "http://localhost:8000/v1" });
	});

	it("accepts a JSON array for fallbackModels", async () => {
		const r = await configSet("fallbackModels", '["openai/gpt-4o"]', cwd);
		assert.equal(r.ok, true);
		const raw = await readFile(path.join(cwd, ".vision-proxy.json"), "utf8");
		assert.deepEqual(JSON.parse(raw).fallbackModels, ["openai/gpt-4o"]);
	});

	it("falls back to the default for malformed JSON values", async () => {
		const r = await configSet("baseURLs", "not-json", cwd);
		assert.equal(r.ok, true);
		const raw = await readFile(path.join(cwd, ".vision-proxy.json"), "utf8");
		assert.deepEqual(JSON.parse(raw).baseURLs, {});
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
});
