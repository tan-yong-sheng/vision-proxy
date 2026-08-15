/**
 * Unit tests for `vp cache` subcommands.
 *
 * Verifies that cache status and prune load the effective config so they
 * respect user-configured cacheSize and cacheMaxAgeDays instead of defaults.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cacheStatus, cachePruneCmd } from "./cache.ts";
import { configureCache, resetCacheState } from "../cache.ts";

let home: string;
let cwd: string;
let cacheFile: string;

beforeEach(async () => {
	home = await mkdtemp(path.join(os.tmpdir(), "vp-home-"));
	cwd = await mkdtemp(path.join(os.tmpdir(), "vp-cwd-"));
	cacheFile = path.join(home, ".vision-proxy", "cache.json");
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	configureCache(10, cacheFile);
	resetCacheState();
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
	delete process.env.HOME;
	delete process.env.USERPROFILE;
	delete process.env.VP_CACHE_SIZE;
	delete process.env.VP_CACHE_MAX_AGE_DAYS;
});

async function writeUserConfig(config: object): Promise<void> {
	const dir = path.join(home, ".vision-proxy");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function writeCacheEntries(entries: Record<string, { value: string; createdAt: number }>): Promise<void> {
	const dir = path.dirname(cacheFile);
	await mkdir(dir, { recursive: true });
	await writeFile(cacheFile, JSON.stringify(entries), "utf8");
}

describe("cacheStatus", () => {
	it("reports the configured cacheSize instead of using the default", async () => {
		await writeUserConfig({ cacheSize: 2 });
		await writeCacheEntries({
			a: { value: "1", createdAt: Date.now() },
			b: { value: "2", createdAt: Date.now() },
			c: { value: "3", createdAt: Date.now() },
		});
		const r = await cacheStatus();
		assert.equal(r.ok, true);
		assert.match(r.message, /entries:\s+2/);
	});
});

describe("cachePruneCmd", () => {
	it("uses configured cacheMaxAgeDays when --older is not provided", async () => {
		await writeUserConfig({ cacheMaxAgeDays: 1 });
		const now = Date.now();
		await writeCacheEntries({
			fresh: { value: "v", createdAt: now },
			stale: { value: "v", createdAt: now - 1000 * 60 * 60 * 48 },
		});
		const r = await cachePruneCmd();
		assert.equal(r.ok, true);
		assert.match(r.message, /pruned 1 entr/);
		const remaining = JSON.parse(await readFile(cacheFile, "utf8"));
		assert.ok("fresh" in remaining);
		assert.ok(!("stale" in remaining));
	});

	it("still respects an explicit --older value", async () => {
		await writeUserConfig({ cacheMaxAgeDays: 1 });
		const now = Date.now();
		await writeCacheEntries({
			fresh: { value: "v", createdAt: now },
			old: { value: "v", createdAt: now - 1000 * 60 * 60 * 36 },
		});
		const r = await cachePruneCmd(2);
		assert.equal(r.ok, true);
		assert.match(r.message, /pruned 0 entr/);
		const remaining = JSON.parse(await readFile(cacheFile, "utf8"));
		assert.ok("fresh" in remaining);
		assert.ok("old" in remaining);
	});

	it("no-ops when configured cacheMaxAgeDays is 0 (disabled)", async () => {
		await writeUserConfig({ cacheMaxAgeDays: 0 });
		const now = Date.now();
		await writeCacheEntries({
			recent: { value: "v", createdAt: now - 1000 * 60 * 60 * 24 },
		});
		const r = await cachePruneCmd();
		assert.equal(r.ok, true);
		assert.match(r.message, /pruned 0 entr/);
		const remaining = JSON.parse(await readFile(cacheFile, "utf8"));
		assert.ok("recent" in remaining);
	});

	it("still respects an explicit --older value when configured age is 0", async () => {
		await writeUserConfig({ cacheMaxAgeDays: 0 });
		const now = Date.now();
		await writeCacheEntries({
			old: { value: "v", createdAt: now - 1000 * 60 * 60 * 48 },
		});
		const r = await cachePruneCmd(1);
		assert.equal(r.ok, true);
		assert.match(r.message, /pruned 1 entr/);
		const remaining = JSON.parse(await readFile(cacheFile, "utf8"));
		assert.ok(!("old" in remaining));
	});
});
