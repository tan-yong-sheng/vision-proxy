/**
 * Unit tests for `vp provider` subcommands.
 *
 * `providerList` / `providerCheck` only read env + the registry, so they run
 * with an isolated env map. `providerStoreKey` / `providerDeleteKey` /
 * `providerListKeys` exercise the keyring backend, swapped for a fake in
 * beforeEach.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { KeyringBackend } from "../keyring.ts";
import { setKeyringBackend } from "../keyring.ts";
import { resolveModel } from "../provider.ts";
import {
	providerCheck,
	providerDeleteKey,
	providerList,
	providerListKeys,
	providerStoreKey,
} from "./provider.ts";

let home: string;
let _env: NodeJS.ProcessEnv;
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
	_env = { ...process.env, HOME: home, USERPROFILE: home };
	savedBackend = undefined;
	setKeyringBackend(fakeBackend());
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	setKeyringBackend(savedBackend);
});

describe("providerList", () => {
	it("lists all known providers and key presence from env", () => {
		const r = providerList({
			OPENAI_API_KEY: "sk-x",
			ANTHROPIC_API_KEY: "",
			GOOGLE_API_KEY: "",
		} as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		assert.match(r.message, /openai/);
		assert.match(r.message, /anthropic/);
		assert.match(r.message, /google/);
		assert.match(r.message, /present/);
		assert.match(r.message, /missing/);
	});

	it("reports keyring-stored keys as present", async () => {
		await providerStoreKey("openai", async () => "sk-keyring\n");
		const r = providerList({
			OPENAI_API_KEY: "",
			ANTHROPIC_API_KEY: "",
			GOOGLE_API_KEY: "",
		} as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		assert.match(r.message, /openai.*present/);
	});

	it("counts a config apiKey as present only for the active provider", () => {
		const config = { apiKey: "cfg-key", provider: "google" };
		const r = providerList(
			{
				OPENAI_API_KEY: "",
				ANTHROPIC_API_KEY: "",
				GOOGLE_API_KEY: "",
			} as NodeJS.ProcessEnv,
			config,
		);
		assert.equal(r.ok, true);
		assert.match(r.message, /google.*present/);
		assert.match(r.message, /openai.*missing/);
	});

	it("ignores an empty config apiKey", () => {
		const r = providerList({ GOOGLE_API_KEY: "" } as NodeJS.ProcessEnv, {
			apiKey: "",
			provider: "google",
		});
		assert.match(r.message, /google.*missing/);
	});
});

describe("providerCheck", () => {
	it("reports MISSING KEY when no env key is present", () => {
		const r = providerCheck(undefined, {
			OPENAI_API_KEY: "",
			ANTHROPIC_API_KEY: "",
		} as NodeJS.ProcessEnv);
		assert.equal(r.ok, false);
		assert.match(r.message, /MISSING KEY/);
	});

	it("reports OK for a provider whose key is present", () => {
		const r = providerCheck("openai", {
			OPENAI_API_KEY: "sk-x",
			ANTHROPIC_API_KEY: "",
		} as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		assert.match(r.message, /openai: OK/);
	});

	it("reports OK for the google provider when its key is present", () => {
		const r = providerCheck("google", { GOOGLE_API_KEY: "gapi-x" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, true);
		assert.match(r.message, /google: OK/);
	});

	it("reports unknown provider for a bad name", () => {
		const r = providerCheck("bogus", {
			OPENAI_API_KEY: "x",
			ANTHROPIC_API_KEY: "y",
		} as NodeJS.ProcessEnv);
		assert.equal(r.ok, false);
		assert.match(r.message, /unknown provider/);
	});

	it("counts a config apiKey as present for the active provider", () => {
		const r = providerCheck("google", { GOOGLE_API_KEY: "" } as NodeJS.ProcessEnv, {
			apiKey: "cfg-key",
			provider: "google",
		});
		assert.equal(r.ok, true);
		assert.match(r.message, /google: OK/);
	});

	it("reports MISSING KEY for a non-active provider with only a config key", () => {
		const r = providerCheck(undefined, { ANTHROPIC_API_KEY: "" } as NodeJS.ProcessEnv, {
			apiKey: "cfg-key",
			provider: "google",
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /anthropic: MISSING KEY/);
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
		const r = resolveModel(
			"openai",
			"gpt-4o",
			{ OPENAI_API_KEY: "" } as NodeJS.ProcessEnv,
			"sk-explicit",
		);
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.model.apiKey, "sk-explicit");
	});

	it("still reports missing key when env and keyring are both empty", () => {
		const r = resolveModel("openai", "gpt-4o", { OPENAI_API_KEY: "" } as NodeJS.ProcessEnv);
		assert.equal(r.ok, false);
	});

	it("prefers the provider env var base URL over an explicit one", () => {
		const r = resolveModel(
			"openai",
			"gpt-4o",
			{ OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "http://env/v1" } as NodeJS.ProcessEnv,
			undefined,
			"http://explicit/v1",
		);
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.model.baseURL, "http://env/v1");
	});

	it("uses an explicit base URL when no env var is set", () => {
		const r = resolveModel(
			"openai",
			"gpt-4o",
			{ OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv,
			undefined,
			"http://explicit/v1",
		);
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.model.baseURL, "http://explicit/v1");
	});
});
