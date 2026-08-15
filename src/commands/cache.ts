/**
 * `vp cache` — pHash / per-image description cache ops.
 *
 * Subcommands:
 *   status            hit rate + size + path
 *   clear             drop all cached entries
 *   prune [--older]  evict entries older than N days (default 30)
 */
import {
	cacheClear,
	cachePrune,
	cacheStats,
	configureCache,
} from "../cache.ts";
import { loadConfig } from "../config.ts";

export interface CacheResult {
	ok: boolean;
	message: string;
	code: number;
}

export async function cacheStatus(): Promise<CacheResult> {
	const { config } = await loadConfig();
	configureCache(config.cacheSize, undefined, config.cacheMaxAgeDays);
	const stats = await cacheStats();
	const pct = (stats.hitRate * 100).toFixed(1);
	return {
		ok: true,
		message:
			`path:      ${stats.path}\n` +
			`entries:   ${stats.entries}\n` +
			`hits:      ${stats.hits}\n` +
			`misses:    ${stats.misses}\n` +
			`hit rate:  ${pct}%`,
		code: 0,
	};
}

export async function cacheClearCmd(): Promise<CacheResult> {
	await cacheClear();
	return { ok: true, message: "cache cleared", code: 0 };
}

export async function cachePruneCmd(
	olderDays?: number,
	maxEntries?: number,
): Promise<CacheResult> {
	const { config } = await loadConfig();
	configureCache(maxEntries ?? config.cacheSize, undefined, config.cacheMaxAgeDays);
	const effectiveDays = olderDays ?? config.cacheMaxAgeDays;
	if (effectiveDays <= 0) {
		return { ok: true, message: "pruned 0 entries", code: 0 };
	}
	const removed = await cachePrune(effectiveDays * 24 * 60 * 60 * 1000);
	return { ok: true, message: `pruned ${removed} entr${removed === 1 ? "y" : "ies"}`, code: 0 };
}
