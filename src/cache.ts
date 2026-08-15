/**
 * Per-image description cache for the vision-proxy CLI.
 *
 * Replaces Pi's `_toolCache` (an in-memory LRU). The CLI backs it with a
 * small JSON file under the user config dir so results survive process restarts,
 * which matters for the cache-first `analyze` path inside a 30s hook budget.
 *
 * Cache key semantics mirror `buildToolCacheKey`: the key already folds in
 * image content hash + crop signature + question hash + model ref, so a hit is
 * safe to return verbatim.
 */
import { LRUCache } from "./core.ts";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

export interface CacheStats {
	entries: number;
	hits: number;
	misses: number;
	hitRate: number;
	path: string;
}

interface CacheRecord {
	value: string;
	createdAt: number;
}

let _cache: LRUCache<string, CacheRecord> | null = null;
let _path: string | null = null;
let _explicitPath: string | null = null;
let _maxAgeDays = 30;

function cachePath(): string {
	if (_explicitPath) return _explicitPath;
	const dir = process.env.VP_CACHE_DIR ?? path.join(os.homedir(), ".vision-proxy");
	return path.join(dir, "cache.json");
}

export function configureCache(
	maxEntries: number,
	cacheFile?: string,
	maxAgeDays = 30,
): void {
	_explicitPath = cacheFile ?? null;
	_path = cacheFile ?? cachePath();
	_maxAgeDays = maxAgeDays;
	_cache = new LRUCache<string, CacheRecord>(Math.max(1, maxEntries));
}

function cache(): LRUCache<string, CacheRecord> {
	if (!_cache) configureCache(50);
	return _cache!;
}

async function load(): Promise<void> {
	const c = cache();
	if (c.size > 0) return;
	try {
		const raw = await fs.readFile(_path ?? cachePath(), "utf8");
		const parsed = JSON.parse(raw) as Record<string, CacheRecord>;
		for (const [k, v] of Object.entries(parsed)) {
			if (v && typeof v.value === "string") c.set(k, v);
		}
	} catch {
		// No cache file yet — start empty.
	}
}

async function persist(): Promise<void> {
	const target = _path ?? cachePath();
	const out: Record<string, CacheRecord> = {};
	for (const [k, v] of cache().entries()) out[k] = v;
	const dir = path.dirname(target);
	try {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	} catch {
		// Ignore: directory may already exist or be inaccessible.
	}
	try {
		await fs.chmod(dir, 0o700);
	} catch {
		// Ignore: may lack permission to change existing directory mode.
	}
	try {
		await fs.writeFile(target, JSON.stringify(out), { encoding: "utf8", mode: 0o600 });
		await fs.chmod(target, 0o600);
	} catch {
		// Best effort.
	}
}

let _hits = 0;
let _misses = 0;

export async function cacheGet(key: string): Promise<string | undefined> {
	await load();
	await pruneStale();
	const hit = cache().get(key);
	if (hit) {
		_hits++;
		// Refresh createdAt on access so prune keeps hot entries.
		cache().set(key, { ...hit, createdAt: Date.now() });
		await persist();
		return hit.value;
	}
	_misses++;
	return undefined;
}

export async function cacheSet(key: string, value: string): Promise<void> {
	await load();
	cache().set(key, { value, createdAt: Date.now() });
	await persist();
}

export async function cacheClear(): Promise<void> {
	cache().clear();
	_hits = 0;
	_misses = 0;
	const target = _path ?? cachePath();
	try {
		await fs.unlink(target);
	} catch {
		// Nothing to remove.
	}
}

/** Remove entries older than `maxAgeMs`; persist if anything was removed. */
async function evictOlderThan(maxAgeMs: number): Promise<number> {
	const c = cache();
	const now = Date.now();
	let removed = 0;
	for (const [k, v] of c.entries()) {
		if (now - v.createdAt > maxAgeMs) {
			c.delete(k);
			removed++;
		}
	}
	if (removed > 0) await persist();
	return removed;
}

/** Evict entries older than `maxAgeMs`. Returns number of entries removed. */
export async function cachePrune(maxAgeMs: number): Promise<number> {
	await load();
	return evictOlderThan(maxAgeMs);
}

/** Evict entries older than the configured max age (lazy prune on access). */
async function pruneStale(): Promise<void> {
	if (_maxAgeDays <= 0) return;
	await load();
	await evictOlderThan(_maxAgeDays * 24 * 60 * 60 * 1000);
}

export async function cacheStats(): Promise<CacheStats> {
	await load();
	const total = _hits + _misses;
	return {
		entries: cache().size,
		hits: _hits,
		misses: _misses,
		hitRate: total > 0 ? _hits / total : 0,
		path: _path ?? cachePath(),
	};
}

/** Reset in-memory stats + cache (used by tests). */
export function resetCacheState(stats = true): void {
	cache().clear();
	if (stats) {
		_hits = 0;
		_misses = 0;
	}
}
