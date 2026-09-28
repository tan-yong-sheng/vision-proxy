/**
 * Tests for the project-overrides-user config warning in `loadConfig`.
 *
 * Trigger semantics: warn (stderr) when the project `.vision-proxy.json`
 * sets baseUrl/systemPrompt/apiKey to a value that differs from the
 * user-level file — nothing overridden (no user file) stays silent.
 * Explicit --config files are exempt (explicit user action = consent).
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "./config.ts";

let cwd: string;
let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let savedWrite: typeof process.stderr.write;
let stderrText: string;

beforeEach(async () => {
	cwd = await mkdtemp(path.join(os.tmpdir(), "vp-cfg-warn-"));
	home = await mkdtemp(path.join(os.tmpdir(), "vp-cfg-warn-home-"));
	// readPersistentFile resolves ~/.vision-proxy/config.json via os.homedir(),
	// which reads USERPROFILE (not HOME) on Windows — isolate both.
	prevHome = process.env.HOME;
	process.env.HOME = home;
	prevUserProfile = process.env.USERPROFILE;
	process.env.USERPROFILE = home;
	stderrText = "";
	savedWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderrText += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stderr.write;
});

afterEach(async () => {
	process.stderr.write = savedWrite;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = prevUserProfile;
	await rm(cwd, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

async function writeUserConfig(obj: Record<string, unknown>): Promise<void> {
	await mkdir(path.join(home, ".vision-proxy"), { recursive: true });
	await writeFile(path.join(home, ".vision-proxy", "config.json"), JSON.stringify(obj), "utf8");
}

async function writeProjectConfig(obj: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(cwd, ".vision-proxy.json"), JSON.stringify(obj), "utf8");
}

describe("loadConfig project-override warning", () => {
	it("warns naming key and project file when project differs from user", async () => {
		await writeUserConfig({ baseUrl: "https://user.example/v1" });
		await writeProjectConfig({ baseUrl: "https://project.example/v1" });
		const { resolvedFrom } = await loadConfig({ cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(resolvedFrom, "project:.vision-proxy.json");
		assert.match(stderrText, /WARNING/);
		assert.match(stderrText, /baseUrl/);
		assert.match(stderrText, /\.vision-proxy\.json/);
	});

	it("stays silent when values are identical", async () => {
		await writeUserConfig({ baseUrl: "https://same.example/v1" });
		await writeProjectConfig({ baseUrl: "https://same.example/v1" });
		await loadConfig({ cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(stderrText, "");
	});

	it("stays silent when there is no user file", async () => {
		await writeProjectConfig({ baseUrl: "https://project.example/v1" });
		await loadConfig({ cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(stderrText, "");
	});

	it("stays silent for non-watched keys (provider/modelId)", async () => {
		await writeUserConfig({ provider: "openai", modelId: "gpt-4o" });
		await writeProjectConfig({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		await loadConfig({ cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(stderrText, "");
	});

	it("is exempt for explicit --config files", async () => {
		await writeUserConfig({ baseUrl: "https://user.example/v1" });
		const explicit = path.join(cwd, "explicit.json");
		await writeFile(explicit, JSON.stringify({ baseUrl: "https://other.example/v1" }), "utf8");
		await loadConfig({ explicitConfigPath: explicit, cwd, env: {} as NodeJS.ProcessEnv });
		assert.equal(stderrText, "");
	});

	it("warns per key and never prints the apiKey value", async () => {
		await writeUserConfig({ baseUrl: "https://user.example/v1", apiKey: "user-secret" });
		await writeProjectConfig({
			baseUrl: "https://project.example/v1",
			apiKey: "project-secret",
		});
		await loadConfig({ cwd, env: {} as NodeJS.ProcessEnv });
		assert.match(stderrText, /baseUrl/);
		assert.match(stderrText, /apiKey/);
		assert.ok(!stderrText.includes("project-secret"), "must not leak the project apiKey");
		assert.ok(!stderrText.includes("user-secret"), "must not leak the user apiKey");
	});
});
