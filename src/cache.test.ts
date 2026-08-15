/**
 * Unit tests for the vision-proxy cache (in-memory LRU + JSON file backing).
 *
 * Uses a temp dir for the cache file so we never touch the user config dir.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	cacheClear,
	cacheGet,
	cachePrune,
	cacheSet,
	cacheStats,
	configureCache,
	resetCacheState,
} from "./cache.ts";

let tmp: string;
let cacheFile: string;

beforeEach(async () => {
	tmp = await mkdtemp(path.join(os.tmpdir(), "vp-cache-"));
	cacheFile = path.join(tmp, "cache.json");
	configureCache(10, cacheFile);
	resetCacheState();
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("cacheGet / cacheSet", () => {
	it("misses then stores then hits", async () => {
		assert.equal(await cacheGet("k1"), undefined);
		await cacheSet("k1", "v1");
		assert.equal(await cacheGet("k1"), "v1");
		const s = await cacheStats();
		assert.equal(s.hits, 1);
		assert.equal(s.misses, 1);
	});

	it("persists to the JSON file", async () => {
		await cacheSet("k1", "v1");
		const raw = await readFile(cacheFile, "utf8");
		const parsed = JSON.parse(raw);
		assert.equal(parsed["k1"].value, "v1");
		assert.equal(typeof parsed["k1"].createdAt, "number");
	});

	it("refreshes createdAt on a hit and persists the update", async () => {
		await cacheSet("k1", "v1");
		const first = JSON.parse(await readFile(cacheFile, "utf8"));
		const originalCreatedAt = first.k1.createdAt;

		// Simulate an older access timestamp and reload from disk.
		first.k1.createdAt = originalCreatedAt - 1000 * 60 * 60 * 24;
		await writeFile(cacheFile, JSON.stringify(first), "utf8");
		configureCache(10, cacheFile);
		resetCacheState(false);

		const hit = await cacheGet("k1");
		assert.equal(hit, "v1");
		const second = JSON.parse(await readFile(cacheFile, "utf8"));
		assert.ok(
			second.k1.createdAt > originalCreatedAt,
			"createdAt must be refreshed and persisted on a cache hit",
		);
	});

	it("writes the cache file and directory with owner-only permissions", async () => {
		await cacheSet("k1", "v1");
		if (process.platform === "win32") return;
		const fileStat = await stat(cacheFile);
		const dirStat = await stat(tmp);
		assert.equal(fileStat.mode & 0o777, 0o600, "cache file must be owner-only");
		assert.equal(dirStat.mode & 0o777, 0o700, "cache directory must be owner-only");
	});

	it("reloads from file on a fresh cache instance", async () => {
		await cacheSet("k1", "v1");
		// Reconfigure to force a reload from the backing file.
		configureCache(10, cacheFile);
		resetCacheState(false);
		assert.equal(await cacheGet("k1"), "v1");
	});
});

describe("cacheClear", () => {
	it("drops all entries and stats", async () => {
		await cacheSet("k1", "v1");
		await cacheClear();
		const s = await cacheStats();
		assert.equal(s.entries, 0);
		assert.equal(s.hits, 0);
		assert.equal(s.misses, 0);
	});
});

describe("cachePrune", () => {
	it("evicts entries older than maxAgeMs", async () => {
		await cacheSet("fresh", "v");
		// Write an artificially old entry directly to the backing file.
		const raw = JSON.parse(await readFile(cacheFile, "utf8"));
		raw.old = { value: "v", createdAt: Date.now() - 1000 * 60 * 60 };
		await writeFile(cacheFile, JSON.stringify(raw), "utf8");
		// Reload then prune entries older than 1 hour.
		configureCache(10, cacheFile);
		resetCacheState(false);
		const removed = await cachePrune(1000 * 60 * 30);
		assert.equal(removed, 1);
		assert.equal(await cacheGet("old"), undefined);
		assert.equal(await cacheGet("fresh"), "v");
	});
});

describe("lazy prune on cacheGet", () => {
	it("evicts stale entries older than cacheMaxAgeDays", async () => {
		// 1-day max age; the stale entry is 2 days old and should be dropped on access.
		configureCache(10, cacheFile, 1);
		await cacheSet("fresh", "v");
		const raw = JSON.parse(await readFile(cacheFile, "utf8"));
		raw.stale = { value: "v", createdAt: Date.now() - 1000 * 60 * 60 * 48 };
		await writeFile(cacheFile, JSON.stringify(raw), "utf8");
		resetCacheState(false);
		// A fresh get should trigger lazy pruning of the 2-day-old entry.
		assert.equal(await cacheGet("fresh"), "v");
		assert.equal(await cacheGet("stale"), undefined);
		assert.equal(await cacheGet("fresh"), "v");
	});

	it("keeps entries within the max age window", async () => {
		configureCache(10, cacheFile, 30);
		await cacheSet("fresh", "v");
		const raw = JSON.parse(await readFile(cacheFile, "utf8"));
		raw.recent = { value: "v", createdAt: Date.now() - 1000 * 60 * 60 * 24 };
		await writeFile(cacheFile, JSON.stringify(raw), "utf8");
		resetCacheState(false);
		assert.equal(await cacheGet("recent"), "v");
	});
});
