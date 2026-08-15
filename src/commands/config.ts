/**
 * `vp config` — manage VisionConfig.
 *
 * Subcommands:
 *   init              scaffold a .vision-proxy.json in the cwd
 *   get               print the resolved config (with precedence notes)
 *   set <k> <v>       set a key in the project .vision-proxy.json
 *   validate          check the resolved config + provider reachability
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, readJsonFile } from "../config.ts";
import { DEFAULT_CONFIG, resolveConfig, type VisionConfig } from "../core.ts";
import { listProviders, resolveModel } from "../provider.ts";

export interface ConfigResult {
	ok: boolean;
	message: string;
	code: number;
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".vision-proxy.json");
}

export async function configInit(cwd: string): Promise<ConfigResult> {
	const target = projectConfigPath(cwd);
	try {
		await fs.access(target);
		return { ok: false, message: `config already exists: ${target}`, code: 1 };
	} catch {
		// does not exist — proceed
	}
	const initial: Partial<VisionConfig> = {
		provider: DEFAULT_CONFIG.provider,
		modelId: DEFAULT_CONFIG.modelId,
		mode: DEFAULT_CONFIG.mode,
	};
	await fs.writeFile(target, JSON.stringify(initial, null, 2) + "\n", "utf8");
	return { ok: true, message: `wrote ${target}`, code: 0 };
}

export async function configGet(opts: {
	configPath?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}): Promise<ConfigResult> {
	const { config, resolvedFrom } = await loadConfig({
		explicitConfigPath: opts.configPath,
		cwd: opts.cwd,
		env: opts.env,
	});
	return {
		ok: true,
		message: `resolved from: ${resolvedFrom}\n` + JSON.stringify(config, null, 2),
		code: 0,
	};
}

export async function configSet(key: string, value: string, cwd: string): Promise<ConfigResult> {
	if (!KNOWN_KEYS.has(key)) {
		return {
			ok: false,
			message: `unknown config key "${key}". Known: ${[...KNOWN_KEYS].join(", ")}`,
			code: 1,
		};
	}
	const target = projectConfigPath(cwd);
	const existing = (await readJsonFile(target)) ?? {};

	const coerced = coerceValue(key, value);
	(existing as Record<string, unknown>)[key] = coerced;
	await fs.writeFile(target, JSON.stringify(existing, null, 2) + "\n", "utf8");
	return { ok: true, message: `set ${key} = ${JSON.stringify(coerced)} in ${target}`, code: 0 };
}

function coerceValue(key: string, value: string): unknown {
	const def = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
	if (typeof def === "number") {
		const n = Number(value);
		return Number.isFinite(n) ? n : def;
	}
	if (typeof def === "boolean") {
		return value === "true" || value === "1" || value === "on";
	}
	// baseURLs (object) and fallbackModels (array) take a JSON literal so callers
	// can set complex values from the CLI. On a parse failure we drop back to the
	// default (sanitize() would otherwise reject the value anyway).
	if (typeof def === "object" && def !== null) {
		try {
			return JSON.parse(value);
		} catch {
			return def;
		}
	}
	return value;
}

export async function configValidate(opts: {
	configPath?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}): Promise<ConfigResult> {
	const { config, resolvedFrom } = await loadConfig({
		explicitConfigPath: opts.configPath,
		cwd: opts.cwd,
		env: opts.env,
	});
	const sanitized = resolveConfig(opts.env ?? process.env, config);

	const problems: string[] = [];
	if (!listProviders().some((p) => p.id === sanitized.provider)) {
		problems.push(`unknown provider "${sanitized.provider}"`);
	}
	if (sanitized.maxImagesPerCall < 1) {
		problems.push("maxImagesPerCall must be >= 1");
	}

	// Reachability: does the provider have a key?
	const probe = resolveModel(sanitized.provider, sanitized.modelId, opts.env ?? process.env);
	const authNote = probe.ok
		? `provider "${sanitized.provider}" reachable (key present)`
		: `provider "${probe.provider}" missing key ${probe.apiKeyEnv}`;

	if (problems.length > 0) {
		return {
			ok: false,
			message: `invalid config (${resolvedFrom}):\n - ${problems.join("\n - ")}`,
			code: 1,
		};
	}
	return {
		ok: true,
		message: `config valid (${resolvedFrom}).\n${authNote}`,
		code: 0,
	};
}
