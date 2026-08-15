/**
 * Unit tests for `vp provider` subcommands.
 *
 * `providerAdd` writes to ~/.vision-proxy/config.json, so we override HOME to a
 * temp dir. `providerList` / `providerCheck` only read env + the registry, so
 * they run with an isolated env map.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { providerAdd, providerCheck, providerList } from "./provider.ts";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
	home = await mkdtemp(path.join(os.tmpdir(), "vp-home-"));
	env = { ...process.env, HOME: home, USERPROFILE: home };
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function userConfigPath(): string {
	return path.join(home, ".vision-proxy", "config.json");
}

describe("providerList", () => {
	it("lists all known providers and key presence from env", () => {
		const r = providerList({ OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "", GOOGLE_API_KEY: "" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		assert.match(r.message, /openai/);
		assert.match(r.message, /anthropic/);
		assert.match(r.message, /google/);
		assert.match(r.message, /present/);
		assert.match(r.message, /missing/);
	});
});

describe("providerAdd", () => {
	it("registers a known provider into the user config", async () => {
		const r = await providerAdd("openai", env, home);
		assert.equal(r.ok, true);
		const raw = await readFile(userConfigPath(), "utf8");
		assert.equal(JSON.parse(raw).provider, "openai");
	});

	it("rejects an unknown provider", async () => {
		const r = await providerAdd("bogus", env);
		assert.equal(r.ok, false);
		assert.equal(r.code, 1);
	});
});

describe("providerCheck", () => {
	it("reports MISSING KEY when no env key is present", () => {
		const r = providerCheck(undefined, { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, false);
		assert.match(r.message, /MISSING KEY/);
	});

	it("reports OK for a provider whose key is present", () => {
		const r = providerCheck("openai", { OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		assert.match(r.message, /openai: OK/);
	});

	it("reports OK for the google provider when its key is present", () => {
		const r = providerCheck("google", { GOOGLE_API_KEY: "gapi-x" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		assert.match(r.message, /google: OK/);
	});

	it("reports unknown provider for a bad name", () => {
		const r = providerCheck("bogus", { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, false);
		assert.match(r.message, /unknown provider/);
	});
});
