/**
 * Unit tests for ACP provider support.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	isKnownProvider,
	listProviders,
	resolveModel,
	resolveAcpModel,
	isAcpProvider,
} from "./provider.ts";

describe("isKnownProvider", () => {
	it("returns true for known API providers", () => {
		assert.equal(isKnownProvider("openai"), true);
		assert.equal(isKnownProvider("anthropic"), true);
		assert.equal(isKnownProvider("google"), true);
	});

	it("returns true for acp provider", () => {
		assert.equal(isKnownProvider("acp"), true);
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
		const result = resolveModel(
			"openai",
			"gpt-4o",
			{ OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.model.provider.id, "openai");
		}
	});

	it("returns missing key when API key is not set", () => {
		const result = resolveModel(
			"openai",
			"gpt-4o",
			{} as NodeJS.ProcessEnv,
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.provider, "openai");
			assert.equal(result.apiKeyEnv, "OPENAI_API_KEY");
		}
	});

	it("returns missing key for unknown provider", () => {
		const result = resolveModel(
			"unknown",
			"model",
			{} as NodeJS.ProcessEnv,
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.provider, "unknown");
		}
	});
});

describe("resolveAcpModel", () => {
	it("returns ok when acpCommand is provided", async () => {
		// This may succeed or fail depending on whether the command exists.
		// We just verify the function runs without throwing.
		const result = await resolveAcpModel({
			command: "echo",
			args: ["test"],
			cwd: "/tmp",
		});
		assert.equal(result.ok, true);
	});
});

describe("isAcpProvider", () => {
	it("returns true for ACP provider spec", () => {
		const acpSpec = listProviders().find((p) => p.id === "acp");
		assert.ok(acpSpec);
		assert.equal(isAcpProvider(acpSpec), true);
	});

	it("returns false for API providers", () => {
		const providers = listProviders().filter((p): p is import("./provider.ts").ApiProviderSpec => p.id !== "acp");
		for (const p of providers) {
			assert.equal(isAcpProvider(p), false);
		}
	});
});
