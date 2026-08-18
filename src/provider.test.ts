/**
 * Unit tests for provider resolution.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isKnownProvider, listProviders, resolveModel } from "./provider.ts";

describe("isKnownProvider", () => {
	it("returns true for known API providers", () => {
		assert.equal(isKnownProvider("openai"), true);
		assert.equal(isKnownProvider("anthropic"), true);
		assert.equal(isKnownProvider("google"), true);
	});

	it("returns false for unknown providers", () => {
		assert.equal(isKnownProvider("unknown"), false);
		assert.equal(isKnownProvider("fake"), false);
	});
});

describe("listProviders", () => {
	it("lists all API providers", () => {
		const providers = listProviders();
		const ids = providers.map((p) => p.id);
		assert.ok(ids.includes("openai"));
		assert.ok(ids.includes("anthropic"));
		assert.ok(ids.includes("google"));
	});
});

describe("resolveModel", () => {
	it("resolves openai with API key", () => {
		const result = resolveModel("openai", "gpt-4o", {
			OPENAI_API_KEY: "sk-test",
		} as NodeJS.ProcessEnv);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.model.provider.id, "openai");
		}
	});

	it("returns missing key when API key is not set", () => {
		const result = resolveModel("openai", "gpt-4o", {} as NodeJS.ProcessEnv);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.provider, "openai");
			assert.equal(result.apiKeyEnv, "OPENAI_API_KEY");
		}
	});

	it("returns missing key for unknown provider", () => {
		const result = resolveModel("unknown", "model", {} as NodeJS.ProcessEnv);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.provider, "unknown");
		}
	});

	it("falls back to configApiKey when no explicit key or env var is set", () => {
		const result = resolveModel(
			"openai",
			"gpt-4o",
			{} as NodeJS.ProcessEnv,
			undefined,
			undefined,
			"cfg-key",
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.model.apiKey, "cfg-key");
		}
	});

	it("prefers explicit apiKey over env and config", () => {
		const result = resolveModel(
			"openai",
			"gpt-4o",
			{ OPENAI_API_KEY: "env-key" } as NodeJS.ProcessEnv,
			"explicit-key",
			undefined,
			"cfg-key",
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.model.apiKey, "explicit-key");
		}
	});

	it("prefers env apiKey over config apiKey", () => {
		const result = resolveModel(
			"openai",
			"gpt-4o",
			{ OPENAI_API_KEY: "env-key" } as NodeJS.ProcessEnv,
			undefined,
			undefined,
			"cfg-key",
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.model.apiKey, "env-key");
		}
	});

	it("ignores empty config apiKey and falls through to missing key", () => {
		const result = resolveModel(
			"openai",
			"gpt-4o",
			{} as NodeJS.ProcessEnv,
			undefined,
			undefined,
			"",
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.apiKeyEnv, "OPENAI_API_KEY");
		}
	});
});
