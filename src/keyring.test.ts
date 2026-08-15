/**
 * Unit tests for the optional keyring credential helpers.
 *
 * `@napi-rs/keyring` is an optional native binding, so we never load it here.
 * Instead we inject a fake in-memory backend via `setKeyringBackend`, which is
 * reset after every test. This exercises the full store/get/delete/list surface
 * and the graceful "unavailable" paths without touching the OS keyring.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type KeyringBackend,
	deleteProviderKey,
	getStoredProviderKey,
	listStoredProviderKeys,
	providerKeyAccount,
	setKeyringBackend,
	storeProviderKey,
} from "./keyring.ts";

function makeFakeBackend(store = new Map<string, string>()): KeyringBackend {
	return {
		get(account) {
			return store.get(account) ?? null;
		},
		set(account, secret) {
			store.set(account, secret);
		},
		delete(account) {
			return store.delete(account);
		},
		list() {
			return [...store.keys()];
		},
	};
}

let savedOverride: KeyringBackend | null | undefined;

beforeEach(() => {
	savedOverride = undefined;
	setKeyringBackend(makeFakeBackend());
});

afterEach(() => {
	setKeyringBackend(savedOverride);
});

describe("providerKeyAccount", () => {
	it("namespaces the account under vp:", () => {
		assert.equal(providerKeyAccount("openai"), "vp:openai");
	});
});

describe("storeProviderKey / getStoredProviderKey", () => {
	it("round-trips a stored key", () => {
		const r = storeProviderKey("openai", "sk-secret");
		assert.deepEqual(r, { ok: true });
		assert.equal(getStoredProviderKey("openai"), "sk-secret");
	});

	it("returns undefined for an unknown provider", () => {
		assert.equal(getStoredProviderKey("anthropic"), undefined);
	});

	it("reports an error and does not throw when the backend rejects set", () => {
		setKeyringBackend({
			get: () => null,
			set: () => {
				throw new Error("lockdown");
			},
			delete: () => false,
			list: () => [],
		});
		const r = storeProviderKey("openai", "sk-secret");
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /lockdown/);
	});

	it("treats an empty stored value as missing", () => {
		storeProviderKey("openai", "");
		assert.equal(getStoredProviderKey("openai"), undefined);
	});
});

describe("deleteProviderKey", () => {
	it("deletes an existing key and reports deleted=true", () => {
		storeProviderKey("openai", "sk-secret");
		const r = deleteProviderKey("openai");
		assert.deepEqual(r, { ok: true, deleted: true });
		assert.equal(getStoredProviderKey("openai"), undefined);
	});

	it("reports deleted=false for a key that was never stored", () => {
		const r = deleteProviderKey("google");
		assert.deepEqual(r, { ok: true, deleted: false });
	});

	it("returns an error when the backend is unavailable", () => {
		setKeyringBackend(null);
		const r = deleteProviderKey("openai");
		assert.equal(r.ok, false);
	});
});

describe("listStoredProviderKeys", () => {
	it("lists only vp:-namespaced entries with their provider id", () => {
		storeProviderKey("openai", "a");
		storeProviderKey("anthropic", "b");
		const r = listStoredProviderKeys();
		assert.deepEqual(r.map((x) => x.providerId).sort(), ["anthropic", "openai"]);
		for (const x of r) assert.ok(x.account.startsWith("vp:"));
	});

	it("returns an empty list when nothing is stored", () => {
		assert.deepEqual(listStoredProviderKeys(), []);
	});

	it("returns an empty list when the backend is unavailable", () => {
		setKeyringBackend(null);
		assert.deepEqual(listStoredProviderKeys(), []);
	});
});

describe("backend unavailable", () => {
	it("storeProviderKey errors when backend is null", () => {
		setKeyringBackend(null);
		const r = storeProviderKey("openai", "sk");
		assert.equal(r.ok, false);
	});

	it("getStoredProviderKey returns undefined when backend is null", () => {
		setKeyringBackend(null);
		assert.equal(getStoredProviderKey("openai"), undefined);
	});
});
