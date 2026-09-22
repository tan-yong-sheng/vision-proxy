/**
 * Unit tests for `vp doctor` offline diagnostics.
 *
 * Every external surface is injected: `loadConfig` resolves from a temp cwd
 * + isolated env (no user files), sharp/cache/integrations/dist go through
 * `DoctorOptions.deps` fakes, and the keyring backend is a fake in-memory
 * store. No test performs network I/O.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { KeyringBackend } from "../keyring.ts";
import { setKeyringBackend } from "../keyring.ts";
import { type DoctorOptions, doctor } from "./doctor.ts";

let cwd: string;
let prevHome: string | undefined;
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

function healthyDeps(overrides: DoctorOptions["deps"] = {}): DoctorOptions["deps"] {
	return {
		nodeVersion: "v22.10.0",
		requiredEngines: ">=22.6.0",
		probeSharp: async () => {},
		cacheWritable: async () => ({ writable: true }),
		integrationStatusText: async () => "vp 0.1.3",
		distPresent: () => true,
		...overrides,
	};
}

function envWithKey(): NodeJS.ProcessEnv {
	return { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv;
}

beforeEach(async () => {
	cwd = await mkdtemp(path.join(os.tmpdir(), "vp-doctor-"));
	prevHome = process.env.HOME;
	process.env.HOME = cwd;
	savedBackend = undefined;
	setKeyringBackend(fakeBackend());
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	setKeyringBackend(savedBackend);
});

describe("doctor", () => {
	it("reports all OK when the environment is healthy", async () => {
		const r = await doctor({ cwd, env: envWithKey(), deps: healthyDeps() });
		assert.equal(r.ok, true);
		assert.equal(r.code, 0);
		assert.ok(r.checks.every((c) => c.severity === "OK"));
		assert.match(r.message, /OK {2}node/);
		assert.match(r.message, /OK {2}sharp/);
		assert.match(r.message, /OK {2}config/);
		assert.match(r.message, /OK {2}auth/);
	});

	it("fails on an old Node version", async () => {
		const r = await doctor({
			cwd,
			env: envWithKey(),
			deps: healthyDeps({ nodeVersion: "v20.0.0" }),
		});
		assert.equal(r.ok, false);
		assert.equal(r.code, 1);
		assert.match(r.message, /FAIL {2}node/);
	});

	it("fails when the sharp binding is broken", async () => {
		const r = await doctor({
			cwd,
			env: envWithKey(),
			deps: healthyDeps({
				probeSharp: async () => {
					throw new Error("libsharp.so missing");
				},
			}),
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /FAIL {2}sharp/);
		assert.match(r.message, /libsharp/);
	});

	it("fails when the provider is unknown", async () => {
		const r = await doctor({
			cwd,
			env: { ...envWithKey(), VP_MODEL: "bogus/x" } as NodeJS.ProcessEnv,
			deps: healthyDeps(),
		});
		assert.equal(r.ok, false);
		assert.equal(r.code, 1);
		assert.match(r.message, /FAIL {2}config/);
		assert.match(r.message, /unknown provider "bogus"/);
	});

	it("fails when the active key is missing", async () => {
		const r = await doctor({ cwd, env: {} as NodeJS.ProcessEnv, deps: healthyDeps() });
		assert.equal(r.ok, false);
		assert.match(r.message, /FAIL {2}auth/);
		assert.match(r.message, /MISSING KEY/);
	});

	it("keeps WARN-only checks from failing the command", async () => {
		const r = await doctor({
			cwd,
			env: envWithKey(),
			deps: healthyDeps({
				cacheWritable: async () => ({ writable: false, detail: "denied" }),
				integrationStatusText: async () => "vp 0.1.3\npi: out of date, run install",
				distPresent: () => false,
			}),
		});
		assert.equal(r.ok, true);
		assert.equal(r.code, 0);
		assert.match(r.message, /WARN {2}cache/);
		assert.match(r.message, /WARN {2}integrations/);
		assert.match(r.message, /WARN {2}build/);
	});

	it("warns when the keyring backend is unavailable", async () => {
		setKeyringBackend(null);
		const r = await doctor({ cwd, env: envWithKey(), deps: healthyDeps() });
		assert.equal(r.ok, true);
		assert.match(r.message, /WARN {2}keyring/);
	});

	it("emits --json with per-check statuses", async () => {
		const r = await doctor({ cwd, env: envWithKey(), deps: healthyDeps(), json: true });
		assert.equal(r.ok, true);
		const parsed = JSON.parse(r.message) as {
			ok: boolean;
			checks: Array<{ name: string; status: string }>;
		};
		assert.equal(parsed.ok, true);
		const byName = new Map(parsed.checks.map((c) => [c.name, c.status]));
		assert.equal(byName.get("node"), "OK");
		assert.equal(byName.get("sharp"), "OK");
		assert.equal(byName.get("config"), "OK");
		assert.equal(byName.get("auth"), "OK");
	});
});
