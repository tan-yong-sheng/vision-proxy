/**
 * Tests for `vp update`.
 *
 * Covers install-method detection across path shapes, version comparison,
 * GitHub release-header resolution, and the update dispatch / dry-run behavior
 * for each install method (curl, homebrew, npm, source).
 */
import { strict as assert } from "node:assert";
import process from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { detectInstallMethod, fetchLatestVersion, normalizeVersion, runUpdate } from "./update.ts";

describe("detectInstallMethod", () => {
	let home: string;
	let userprofile: string | undefined;

	beforeEach(() => {
		home = process.env.HOME ?? "";
		userprofile = process.env.USERPROFILE;
	});

	afterEach(() => {
		if (home) process.env.HOME = home;
		else delete process.env.HOME;
		if (userprofile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = userprofile;
	});

	it("detects the curl installer under ~/.local/share/vision-proxy", () => {
		process.env.HOME = "/home/alice";
		const p = "/home/alice/.local/share/vision-proxy/v0.1.0/vp";
		assert.equal(detectInstallMethod(p), "curl");
	});

	it("detects Homebrew via /Cellar/ in the path", () => {
		assert.equal(detectInstallMethod("/opt/homebrew/Cellar/vision-proxy/0.1.0/bin/vp"), "homebrew");
	});

	it("detects Homebrew via /homebrew/ in the path", () => {
		assert.equal(detectInstallMethod("/usr/local/homebrew/bin/vp"), "homebrew");
	});

	it("detects npm via node_modules in the path", () => {
		assert.equal(detectInstallMethod("/usr/local/lib/node_modules/vision-proxy/bin/vp"), "npm");
	});

	it("falls back to source for a local checkout", () => {
		assert.equal(detectInstallMethod("/home/alice/code/vision-proxy/dist/cli.js"), "source");
	});

	it("falls back to source when HOME is unset", () => {
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		assert.equal(detectInstallMethod("/some/.local/share/vision-proxy/v0.1.0/vp"), "source");
	});
});

describe("normalizeVersion", () => {
	it("strips a leading v", () => {
		assert.equal(normalizeVersion("v0.1.2"), "0.1.2");
	});

	it("leaves a bare version untouched", () => {
		assert.equal(normalizeVersion("0.1.2"), "0.1.2");
	});

	it("treats v0.1.2 and 0.1.2 as equal", () => {
		assert.equal(normalizeVersion("v0.1.2"), normalizeVersion("0.1.2"));
	});
});

describe("fetchLatestVersion", () => {
	it("extracts the tag from a GitHub release Location redirect", async () => {
		const probe = async (url: string) => {
			assert.match(url, /\/releases\/latest$/);
			return "v0.2.0";
		};
		assert.equal(await fetchLatestVersion("tan-yong-sheng/vision-proxy", probe), "v0.2.0");
	});

	it("throws after exhausting retries with no redirect", async () => {
		const probe = async () => null;
		await assert.rejects(
			() => fetchLatestVersion("tan-yong-sheng/vision-proxy", probe),
			/resolve latest release/,
		);
	});

	it("returns the tag on the first success after failures", async () => {
		let calls = 0;
		const probe = async () => {
			calls++;
			if (calls < 2) throw new Error("network blip");
			return "v1.0.0";
		};
		assert.equal(await fetchLatestVersion("tan-yong-sheng/vision-proxy", probe), "v1.0.0");
		assert.equal(calls, 2);
	});
});

describe("runUpdate - external package managers", () => {
	it("prints Homebrew guidance", async () => {
		const r = await runUpdate({ binPath: "/opt/homebrew/Cellar/vision-proxy/0.1.0/bin/vp" });
		assert.equal(r.ok, true);
		assert.match(r.message, /installed via Homebrew/);
		assert.match(r.message, /brew upgrade vision-proxy/);
	});

	it("prints npm guidance", async () => {
		const r = await runUpdate({ binPath: "/usr/lib/node_modules/vision-proxy/bin/vp" });
		assert.equal(r.ok, true);
		assert.match(r.message, /installed via npm/);
		assert.match(r.message, /npm install -g vision-proxy/);
	});

	it("prints source-build guidance", async () => {
		const r = await runUpdate({ binPath: "/home/dev/vision-proxy/dist/cli.js" });
		assert.equal(r.ok, true);
		assert.match(r.message, /local source build/);
		assert.match(r.message, /npm run build/);
	});
});

describe("runUpdate - curl install", () => {
	const curlBin = "/home/alice/.local/share/vision-proxy/v0.1.0/vp";
	const savedHome = process.env.HOME;
	beforeEach(() => {
		process.env.HOME = "/home/alice";
	});
	afterEach(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
	});

	it("reports up-to-date when already on the latest", async () => {
		const probe = async () => "v0.1.0";
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			httpProbe: probe,
		});
		assert.equal(r.ok, true);
		assert.match(r.message, /already up to date \(v0.1.0\)/);
	});

	it("--check reports available update without installing", async () => {
		const probe = async () => "v0.2.0";
		let installed = false;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			check: true,
			httpProbe: probe,
			runner: async () => {
				installed = true;
				return 0;
			},
		});
		assert.equal(installed, false);
		assert.match(r.message, /A new version of vision-proxy is available: v0.2.0/);
	});

	it("--check reports up-to-date without installing", async () => {
		const probe = async () => "v0.1.0";
		let installed = false;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			check: true,
			httpProbe: probe,
			runner: async () => {
				installed = true;
				return 0;
			},
		});
		assert.equal(installed, false);
		assert.match(r.message, /already up to date \(v0.1.0\)/);
	});

	it("installs the latest when a newer version exists", async () => {
		const probe = async () => "v0.2.0";
		let ran: string[] | null = null;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			httpProbe: probe,
			runner: async (args) => {
				ran = args;
				return 0;
			},
		});
		assert.equal(r.ok, true);
		assert.match(r.message, /updated to v0.2.0/);
		assert.ok(ran !== null);
		assert.deepEqual(ran, [
			"https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh",
			"--version",
			"v0.2.0",
		]);
	});

	it("--force reinstalls even when already up to date", async () => {
		const probe = async () => "v0.1.0";
		let ran = false;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			force: true,
			httpProbe: probe,
			runner: async () => {
				ran = true;
				return 0;
			},
		});
		assert.equal(ran, true);
		assert.match(r.message, /updated to v0.1.0/);
	});

	it("--version pins a specific release", async () => {
		let ran: string[] | null = null;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			version: "v0.0.9",
			runner: async (args) => {
				ran = args;
				return 0;
			},
		});
		assert.equal(r.ok, true);
		assert.ok(ran !== null);
		assert.deepEqual(ran?.[ran.length - 1], "v0.0.9");
	});

	it("reports a failure when the installer exits non-zero", async () => {
		const probe = async () => "v0.2.0";
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			httpProbe: probe,
			runner: async () => 3,
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /installer exited with code 3/);
		assert.equal(r.code, 3);
	});

	it("reports a failure when the release check fails", async () => {
		const probe = async () => null;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			httpProbe: probe,
			runner: async () => 0,
		});
		assert.equal(r.ok, false);
		assert.match(r.message, /update failed/);
	});
});
