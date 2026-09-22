/**
 * Unit tests for `vp provider` subcommands.
 *
 * `providerList` / `providerCheck` only read env + the registry, so they run
 * with an isolated env map. `providerStoreKey` / `providerDeleteKey` /
 * `providerListKeys` exercise the keyring backend, swapped for a fake in
 * beforeEach.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { KeyringBackend } from "../keyring.ts";
import { setKeyringBackend } from "../keyring.ts";
import { resolveModel } from "../provider.ts";
import {
	classifyProbeError,
	providerCheck,
	providerDeleteKey,
	providerList,
	providerListKeys,
	providerStoreKey,
	providerTest,
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

describe("providerTest", () => {
	let cwd: string;
	let prevHome: string | undefined;

	beforeEach(async () => {
		cwd = await mkdtemp(path.join(os.tmpdir(), "vp-provider-test-"));
		// Isolate user config: loadConfig() reads ~/.vision-proxy/config.json
		// via os.homedir(), so point HOME at the empty temp dir.
		prevHome = process.env.HOME;
		process.env.HOME = cwd;
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	});

	function envWithKey(): NodeJS.ProcessEnv {
		return { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv;
	}

	it("reports TEXT OK / VISION OK when both probes succeed", async () => {
		const calls: unknown[] = [];
		const r = await providerTest({
			provider: "openai",
			env: envWithKey(),
			cwd,
			generateTextImpl: async (opts) => {
				calls.push(opts);
				return { text: "OK" };
			},
		});
		assert.equal(r.ok, true);
		assert.equal(r.code, 0);
		assert.match(r.message, /Source: env \(OPENAI_API_KEY\)/);
		assert.match(r.message, /Model: openai\//);
		assert.match(r.message, /Text: OK/);
		assert.match(r.message, /Vision: OK/);
		assert.match(r.message, /Connection test successful/);
		assert.equal(calls.length, 2);
		assert.doesNotMatch(r.message, /sk-test/);
	});

	it("distinguishes TEXT OK / VISION FAIL for a text-only endpoint", async () => {
		let n = 0;
		const r = await providerTest({
			provider: "openai",
			env: envWithKey(),
			cwd,
			generateTextImpl: async () => {
				n += 1;
				if (n === 1) return { text: "OK" };
				throw new Error("400 image not supported by this model");
			},
		});
		assert.equal(r.ok, false);
		assert.equal(r.code, 1);
		assert.match(r.message, /Text: OK/);
		assert.match(r.message, /Vision: FAIL/);
		assert.match(r.message, /does not accept images/);
	});

	it("fails closed with an actionable 401 message", async () => {
		const r = await providerTest({
			provider: "openai",
			env: envWithKey(),
			cwd,
			generateTextImpl: async () => {
				throw new Error("401 Unauthorized: incorrect API key");
			},
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /Text: FAIL/);
		assert.match(r.message, /authentication failed \(401\)/);
		assert.doesNotMatch(r.message, /sk-test/);
	});

	it("times out with an actionable message", async () => {
		const r = await providerTest({
			provider: "openai",
			env: envWithKey(),
			cwd,
			generateTextImpl: async () => {
				throw new Error("timed out after 30000ms");
			},
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /timed out/);
	});

	it("emits --json with separate text/vision statuses", async () => {
		const r = await providerTest({
			provider: "openai",
			env: envWithKey(),
			cwd,
			json: true,
			generateTextImpl: async () => ({ text: "OK" }),
		});
		assert.equal(r.ok, true);
		const parsed = JSON.parse(r.message) as {
			provider: string;
			text: { status: string };
			vision: { status: string };
		};
		assert.equal(parsed.provider, "openai");
		assert.equal(parsed.text.status, "OK");
		assert.equal(parsed.vision.status, "OK");
		assert.doesNotMatch(r.message, /sk-test/);
	});

	it("rejects an unknown provider without calling the model", async () => {
		let called = false;
		const r = await providerTest({
			provider: "bogus",
			env: envWithKey(),
			cwd,
			generateTextImpl: async () => {
				called = true;
				return { text: "OK" };
			},
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /unknown provider "bogus"/);
		assert.equal(called, false);
	});

	it("requires a key and never prints it", async () => {
		let called = false;
		const r = await providerTest({
			provider: "openai",
			env: {} as NodeJS.ProcessEnv,
			cwd,
			generateTextImpl: async () => {
				called = true;
				return { text: "OK" };
			},
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /no API key/);
		assert.equal(called, false);
	});

	it("reads --image through the injected reader", async () => {
		const img = path.join(cwd, "probe.png");
		await writeFile(img, "fake");
		let seenPath = "";
		const r = await providerTest({
			provider: "openai",
			env: envWithKey(),
			cwd,
			imagePath: img,
			generateTextImpl: async () => ({ text: "OK" }),
			readImage: async (p) => {
				seenPath = p;
				return { data: Buffer.from("x").toString("base64"), mimeType: "image/png" };
			},
		});
		assert.equal(r.ok, true);
		assert.equal(seenPath, img);
	});

	it("fails when --image is unreadable", async () => {
		const r = await providerTest({
			provider: "openai",
			env: envWithKey(),
			cwd,
			imagePath: path.join(cwd, "missing.png"),
			generateTextImpl: async () => ({ text: "OK" }),
			readImage: async () => ({ error: "not found" }),
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /could not read --image/);
	});

	it("rejects a non-positive --timeout", async () => {
		const r = await providerTest({
			provider: "openai",
			env: envWithKey(),
			cwd,
			timeoutMs: 0,
			generateTextImpl: async () => ({ text: "OK" }),
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /--timeout/);
	});
});

describe("classifyProbeError", () => {
	it("labels 404 as a model problem", () => {
		assert.match(classifyProbeError(new Error("404 model not found")), /model not found \(404\)/);
	});

	it("labels image-unsupported 400s as vision-incapable", () => {
		assert.match(
			classifyProbeError(new Error("400 image not supported by this model")),
			/vision-capable/,
		);
	});

	it("passes unknown errors through verbatim", () => {
		assert.equal(classifyProbeError(new Error("weird")), "weird");
	});
});
