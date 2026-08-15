/**
 * Unit tests for `vp provider` subcommands.
 *
 * `providerList` / `providerCheck` only read env + the registry, so they run
 * with an isolated env map. `providerStoreKey` / `providerDeleteKey` /
 * `providerListKeys` exercise the keyring backend, swapped for a fake in
 * beforeEach.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { providerCheck, providerList, providerDeleteKey, providerListKeys, providerStoreKey } from "./provider.ts";
import { resolveModel } from "../provider.ts";
import { setKeyringBackend } from "../keyring.ts";
import type { KeyringBackend } from "../keyring.ts";

let home: string;
let env: NodeJS.ProcessEnv;
let savedBackend: KeyringBackend | null | undefined;

function fakeBackend(): KeyringBackend {
	const store = new Map<string, string>();
	return {
		get: (a) => store.get(a) ?? null,
		set: (a, s) => void store.set(a, s),
		delete: (a) => store.delete(a),
		list: () => [...store.keys()],
	};
}

beforeEach(async () => {
	home = await mkdtemp(path.join(os.tmpdir(), "vp-home-"));
	env = { ...process.env, HOME: home, USERPROFILE: home };
	savedBackend = undefined;
	setKeyringBackend(fakeBackend());
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	setKeyringBackend(savedBackend);
});

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

	it("reports keyring-stored keys as present", async () => {
		await providerStoreKey("openai", async () => "sk-keyring\n");
		const r = providerList({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GOOGLE_API_KEY: "" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		assert.match(r.message, /openai.*present/);
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

describe("providerStoreKey", () => {
	it("stores a key read from stdin", async () => {
		const r = await providerStoreKey("openai", async () => "sk-from-stdin\n");
		assert.equal(r.ok, true);
		assert.match(r.message, /stored key for "openai"/);
	});

	it("rejects an unknown provider", async () => {
		const r = await providerStoreKey("bogus", async () => "x");
		assert.equal(r.ok, false);
		assert.equal(r.code, 1);
	});

	it("rejects empty stdin input", async () => {
		const r = await providerStoreKey("openai", async () => "");
		assert.equal(r.ok, false);
		assert.match(r.message, /no key read/);
	});
});

describe("providerDeleteKey", () => {
	it("deletes a stored key", async () => {
		await providerStoreKey("openai", async () => "sk-x");
		const r = providerDeleteKey("openai");
		assert.equal(r.ok, true);
		assert.match(r.message, /deleted key for "openai"/);
	});

	it("reports when no key was stored", () => {
		const r = providerDeleteKey("anthropic");
		assert.equal(r.ok, true);
		assert.match(r.message, /no stored key/);
	});

	it("rejects an unknown provider", () => {
		const r = providerDeleteKey("bogus");
		assert.equal(r.ok, false);
	});
});

describe("providerListKeys", () => {
	it("lists providers with stored keys", async () => {
		await providerStoreKey("openai", async () => "sk-x");
		await providerStoreKey("anthropic", async () => "sk-y");
		const r = providerListKeys();
		assert.equal(r.ok, true);
		assert.match(r.message, /openai/);
		assert.match(r.message, /anthropic/);
	});

	it("reports none when the keyring is empty", () => {
		const r = providerListKeys();
		assert.equal(r.ok, true);
		assert.match(r.message, /no keys stored/);
	});
});

describe("resolveModel keyring fallback", () => {
	it("falls back to a keyring-stored key when env has none", () => {
		const store = new Map<string, string>([["vp:openai", "sk-from-keyring"]]);
		setKeyringBackend({
			get: (a) => store.get(a) ?? null,
			set: (a, s) => void store.set(a, s),
			delete: (a) => store.delete(a),
			list: () => [...store.keys()],
		});
		const r = resolveModel("openai", "gpt-4o", { OPENAI_API_KEY: "" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.model.apiKey, "sk-from-keyring");
	});

	it("prefers an explicit key over the keyring", () => {
		const store = new Map<string, string>([["vp:openai", "sk-from-keyring"]]);
		setKeyringBackend({
			get: (a) => store.get(a) ?? null,
			set: (a, s) => void store.set(a, s),
			delete: (a) => store.delete(a),
			list: () => [...store.keys()],
		});
		const r = resolveModel("openai", "gpt-4o", { OPENAI_API_KEY: "" } as NodeJS.ProcessEnv, "sk-explicit");
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.model.apiKey, "sk-explicit");
	});

	it("still reports missing key when env and keyring are both empty", () => {
		const r = resolveModel("openai", "gpt-4o", { OPENAI_API_KEY: "" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, false);
	});
});
