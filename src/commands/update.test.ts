/**
 * Tests for `vp update`.
 *
 * Covers install-method detection across path shapes, version comparison,
 * GitHub release-header resolution, the update dispatch / dry-run behavior
 * for each install method (curl, homebrew, npm, source), and the background
 * update notifier (cache round-trip, TTL, banner, and suppression rules).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	checkAutoUpdateNotification,
	detectInstallMethod,
	fetchLatestPrerelease,
	fetchLatestVersion,
	isNewerVersion,
	isNotifierSuppressed,
	isUpdateCacheStale,
	loadUpdateCache,
	normalizeVersion,
	renderUpdateNotice,
	runBackgroundCheck,
	runUpdate,
	saveUpdateCache,
	UPDATE_CHECK_TTL_MS,
} from "./update.ts";

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

describe("fetchLatestPrerelease", () => {
	it("extracts the newest entry title from the prerelease feed", async () => {
		const probe = async (url: string) => {
			assert.match(url, /\/releases\/prereleases\.atom$/);
			return "v0.3.0-rc.1";
		};
		assert.equal(await fetchLatestPrerelease("tan-yong-sheng/vision-proxy", probe), "v0.3.0-rc.1");
	});

	it("throws after exhausting retries with no feed entry", async () => {
		const probe = async () => null;
		await assert.rejects(
			() => fetchLatestPrerelease("tan-yong-sheng/vision-proxy", probe),
			/resolve latest pre-release/,
		);
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

	it("--beta installs the latest pre-release", async () => {
		const probe = async () => "v0.3.0-rc.1";
		let ran: string[] | null = null;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			beta: true,
			httpProbe: probe,
			runner: async (args) => {
				ran = args;
				return 0;
			},
		});
		assert.equal(r.ok, true);
		assert.match(r.message, /updated to v0.3.0-rc.1/);
		assert.ok(ran !== null);
		assert.equal(ran?.[ran.length - 1], "v0.3.0-rc.1");
	});

	it("--beta --check reports the pre-release without installing", async () => {
		const probe = async () => "v0.3.0-rc.1";
		let installed = false;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.1.0",
			beta: true,
			check: true,
			httpProbe: probe,
			runner: async () => {
				installed = true;
				return 0;
			},
		});
		assert.equal(installed, false);
		assert.match(r.message, /A new pre-release of vision-proxy is available: v0.3.0-rc.1/);
		assert.match(r.message, /vp update --beta/);
	});

	it("--beta --force reinstalls even when already on the pre-release", async () => {
		const probe = async () => "v0.3.0-rc.1";
		let ran = false;
		const r = await runUpdate({
			binPath: curlBin,
			currentVersion: "0.3.0-rc.1",
			beta: true,
			force: true,
			httpProbe: probe,
			runner: async () => {
				ran = true;
				return 0;
			},
		});
		assert.equal(ran, true);
		assert.match(r.message, /updated to v0.3.0-rc.1/);
	});
});

describe("update cache", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "vp-update-cache-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when the cache file is missing", () => {
		assert.equal(loadUpdateCache({ cacheDir: dir }), null);
	});

	it("round-trips checked_at and latest_version", () => {
		const cache = { checked_at: "2026-08-22T00:00:00.000Z", latest_version: "v0.2.0" };
		saveUpdateCache(cache, { cacheDir: dir });
		assert.deepEqual(loadUpdateCache({ cacheDir: dir }), cache);
	});

	it("writes update-check.json into the cache dir", () => {
		saveUpdateCache(
			{ checked_at: "2026-08-22T00:00:00.000Z", latest_version: "v9.9.9" },
			{
				cacheDir: dir,
			},
		);
		const raw = JSON.parse(readFileSync(path.join(dir, "update-check.json"), "utf8"));
		assert.equal(raw.latest_version, "v9.9.9");
	});

	it("returns null for malformed JSON", () => {
		writeFileSync(path.join(dir, "update-check.json"), "{not json");
		assert.equal(loadUpdateCache({ cacheDir: dir }), null);
	});

	it("returns null when required fields are missing", () => {
		writeFileSync(
			path.join(dir, "update-check.json"),
			JSON.stringify({ latest_version: "v1.0.0" }),
		);
		assert.equal(loadUpdateCache({ cacheDir: dir }), null);
	});
});

describe("isUpdateCacheStale", () => {
	const now = Date.parse("2026-08-22T12:00:00.000Z");

	it("treats a missing cache as stale", () => {
		assert.equal(isUpdateCacheStale(null, now), true);
	});

	it("keeps a cache written one hour ago fresh", () => {
		const checked = new Date(now - 60 * 60 * 1000).toISOString();
		assert.equal(isUpdateCacheStale({ checked_at: checked, latest_version: "v1" }, now), false);
	});

	it("marks a cache older than the 24h TTL as stale", () => {
		const checked = new Date(now - UPDATE_CHECK_TTL_MS - 1).toISOString();
		assert.equal(isUpdateCacheStale({ checked_at: checked, latest_version: "v1" }, now), true);
	});

	it("marks a cache exactly at the TTL boundary as stale", () => {
		const checked = new Date(now - UPDATE_CHECK_TTL_MS).toISOString();
		assert.equal(isUpdateCacheStale({ checked_at: checked, latest_version: "v1" }, now), true);
	});

	it("treats an unparseable timestamp as stale", () => {
		assert.equal(isUpdateCacheStale({ checked_at: "yesterday", latest_version: "v1" }, now), true);
	});
});

describe("isNewerVersion", () => {
	it("detects a newer patch release", () => {
		assert.equal(isNewerVersion("v0.1.2", "0.1.1"), true);
	});

	it("returns false for the same version", () => {
		assert.equal(isNewerVersion("v0.1.1", "0.1.1"), false);
	});

	it("returns false for an older version", () => {
		assert.equal(isNewerVersion("v0.1.0", "0.1.1"), false);
	});

	it("compares numerically, not lexically", () => {
		assert.equal(isNewerVersion("v0.10.0", "0.9.0"), true);
		assert.equal(isNewerVersion("v0.9.0", "0.10.0"), false);
	});

	it("returns false for an unparseable tag", () => {
		assert.equal(isNewerVersion("nightly", "0.1.1"), false);
	});
});

describe("renderUpdateNotice", () => {
	it("names both versions and the upgrade command", () => {
		const notice = renderUpdateNotice("v0.1.2", "0.1.1");
		assert.match(notice, /A new version of vision-proxy is available: v0\.1\.2/);
		assert.match(notice, /\(current: v0\.1\.1\)/);
		assert.match(notice, /Run 'vp update' to upgrade\./);
	});

	it("renders a single line", () => {
		assert.equal(renderUpdateNotice("v0.1.2", "v0.1.1").includes("\n"), false);
	});
});

describe("isNotifierSuppressed", () => {
	const tty = { env: {} as NodeJS.ProcessEnv, isTTY: true };

	it("allows the notifier on an interactive terminal", () => {
		assert.equal(isNotifierSuppressed(tty), false);
	});

	it("suppresses during vp hook", () => {
		assert.equal(isNotifierSuppressed({ ...tty, command: "hook" }), true);
	});

	it("suppresses for --json output", () => {
		assert.equal(isNotifierSuppressed({ ...tty, json: true }), true);
	});

	it("suppresses under CI", () => {
		assert.equal(isNotifierSuppressed({ ...tty, env: { CI: "1" } }), true);
	});

	it("suppresses when VP_NO_UPDATE_NOTIFIER is set", () => {
		assert.equal(isNotifierSuppressed({ ...tty, env: { VP_NO_UPDATE_NOTIFIER: "1" } }), true);
	});

	it("suppresses when stderr is not a TTY", () => {
		assert.equal(isNotifierSuppressed({ ...tty, isTTY: false }), true);
	});
});

describe("checkAutoUpdateNotification", () => {
	let dir: string;
	let warnings: string[];
	let spawns: string[][];

	function opts(over: Record<string, unknown> = {}) {
		return {
			cacheDir: dir,
			env: {} as NodeJS.ProcessEnv,
			isTTY: true,
			currentVersion: "0.1.1",
			warn: (m: string) => warnings.push(m),
			spawner: (_c: string, args: string[]) => spawns.push(args),
			...over,
		};
	}

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "vp-notify-"));
		warnings = [];
		spawns = [];
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("warns when the cached release is newer", () => {
		saveUpdateCache(
			{ checked_at: new Date().toISOString(), latest_version: "v0.2.0" },
			{
				cacheDir: dir,
			},
		);
		checkAutoUpdateNotification(opts());
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /A new version of vision-proxy is available: v0\.2\.0/);
	});

	it("stays silent when already on the latest", () => {
		saveUpdateCache(
			{ checked_at: new Date().toISOString(), latest_version: "v0.1.1" },
			{
				cacheDir: dir,
			},
		);
		checkAutoUpdateNotification(opts());
		assert.deepEqual(warnings, []);
	});

	it("does not spawn a refresh while the cache is fresh", () => {
		saveUpdateCache(
			{ checked_at: new Date().toISOString(), latest_version: "v0.1.1" },
			{
				cacheDir: dir,
			},
		);
		checkAutoUpdateNotification(opts());
		assert.deepEqual(spawns, []);
	});

	it("spawns a background check when the cache is missing", () => {
		checkAutoUpdateNotification(opts());
		assert.equal(spawns.length, 1);
		assert.deepEqual(spawns[0]?.slice(-2), ["update", "--background-check"]);
	});

	it("spawns a background check when the cache is past the TTL", () => {
		const stale = new Date(Date.now() - UPDATE_CHECK_TTL_MS - 1000).toISOString();
		saveUpdateCache({ checked_at: stale, latest_version: "v0.1.1" }, { cacheDir: dir });
		checkAutoUpdateNotification(opts());
		assert.equal(spawns.length, 1);
	});

	it("neither warns nor spawns during vp hook", () => {
		saveUpdateCache(
			{ checked_at: new Date().toISOString(), latest_version: "v0.2.0" },
			{
				cacheDir: dir,
			},
		);
		checkAutoUpdateNotification(opts({ command: "hook" }));
		assert.deepEqual(warnings, []);
		assert.deepEqual(spawns, []);
	});

	it("neither warns nor spawns for --json", () => {
		saveUpdateCache(
			{ checked_at: new Date().toISOString(), latest_version: "v0.2.0" },
			{
				cacheDir: dir,
			},
		);
		checkAutoUpdateNotification(opts({ json: true }));
		assert.deepEqual(warnings, []);
		assert.deepEqual(spawns, []);
	});

	it("neither warns nor spawns under CI", () => {
		saveUpdateCache(
			{ checked_at: new Date().toISOString(), latest_version: "v0.2.0" },
			{
				cacheDir: dir,
			},
		);
		checkAutoUpdateNotification(opts({ env: { CI: "1" } }));
		assert.deepEqual(warnings, []);
		assert.deepEqual(spawns, []);
	});

	it("marks the spawned child with VP_NO_UPDATE_NOTIFIER so it cannot recurse", () => {
		let childEnv: NodeJS.ProcessEnv | undefined;
		checkAutoUpdateNotification(
			opts({
				spawner: (_c: string, _a: string[], env: NodeJS.ProcessEnv) => {
					childEnv = env;
				},
			}),
		);
		assert.equal(childEnv?.VP_NO_UPDATE_NOTIFIER, "1");
	});
});

describe("runBackgroundCheck", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "vp-bgcheck-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the resolved tag with a fresh timestamp", async () => {
		await runBackgroundCheck({ cacheDir: dir, httpProbe: async () => "v0.3.0" });
		const cache = loadUpdateCache({ cacheDir: dir });
		assert.equal(cache?.latest_version, "v0.3.0");
		assert.equal(isUpdateCacheStale(cache), false);
	});

	it("leaves the previous cache intact when the probe fails", async () => {
		const prior = { checked_at: "2026-08-01T00:00:00.000Z", latest_version: "v0.1.0" };
		saveUpdateCache(prior, { cacheDir: dir });
		await runBackgroundCheck({ cacheDir: dir, httpProbe: async () => null });
		assert.deepEqual(loadUpdateCache({ cacheDir: dir }), prior);
	});

	it("never throws when the probe rejects", async () => {
		await runBackgroundCheck({
			cacheDir: dir,
			httpProbe: async () => {
				throw new Error("offline");
			},
		});
		assert.equal(loadUpdateCache({ cacheDir: dir }), null);
	});
});
