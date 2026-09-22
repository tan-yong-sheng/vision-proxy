/**
 * `vp config` — manage VisionConfig.
 *
 * Subcommands:
 *   init              scaffold a .vision-proxy.json in the cwd
 *   get               print the resolved config (with precedence notes)
 *   set <k> <v>       set a key in the project .vision-proxy.json
 *   validate          check the resolved config + provider key presence
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, readJsonFile } from "../config.ts";
import { DEFAULT_CONFIG, resolveConfig, type VisionConfig } from "../core.ts";
import { getStoredProviderKey } from "../keyring.ts";
import { type ApiProviderSpec, listProviders, resolveModel } from "../provider.ts";

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
	await fs.writeFile(target, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
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
	// Redact the API key before printing so `config get` does not leak secrets.
	const displayConfig = { ...config, apiKey: config.apiKey ? "***" : "" };
	return {
		ok: true,
		message: `resolved from: ${resolvedFrom}\n${JSON.stringify(displayConfig, null, 2)}`,
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
	await fs.writeFile(target, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
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
	// baseUrl (string) - just return the value as-is
	if (key === "baseUrl") {
		return value;
	}
	return value;
}

/**
 * Human-readable view of the effective config. Shares `loadConfig()` with
 * `configGet` (explicit > project > user > env > defaults); `get` stays the
 * JSON/machine variant. Never prints key material.
 */
export async function configShow(opts: {
	provider?: string;
	configPath?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}): Promise<ConfigResult> {
	const env = opts.env ?? process.env;
	const { config, resolvedFrom } = await loadConfig({
		explicitConfigPath: opts.configPath,
		cwd: opts.cwd,
		env,
	});
	const sanitized = resolveConfig(env, config);
	const providers = opts.provider
		? listProviders().filter((p) => p.id === opts.provider)
		: listProviders().filter((p) => p.id === sanitized.provider);
	if (providers.length === 0) {
		return {
			ok: false,
			message: `unknown provider "${opts.provider}". Known: ${listProviders()
				.map((p) => p.id)
				.join(", ")}`,
			code: 1,
		};
	}
	const lines = [`resolved from: ${resolvedFrom}`];
	for (const spec of providers) {
		const active = spec.id === sanitized.provider ? " (active)" : "";
		const model = spec.id === sanitized.provider ? sanitized.modelId : spec.defaultModelId;
		lines.push(`provider: ${spec.id}${active}`);
		lines.push(`model: ${spec.id}/${model}`);
		if (spec.id === sanitized.provider && sanitized.baseUrl) {
			lines.push(`baseUrl: ${redactBaseUrl(sanitized.baseUrl)}`);
		}
		lines.push(`key: ${describeKeySource(spec, env, sanitized)}`);
	}
	if (!opts.provider) {
		lines.push(`mode: ${sanitized.mode}`);
		lines.push(`cacheSize: ${sanitized.cacheSize}`);
	}
	return { ok: true, message: lines.join("\n"), code: 0 };
}

function redactBaseUrl(url: string): string {
	try {
		const u = new URL(url);
		if (u.username || u.password) {
			u.username = "***";
			u.password = "***";
		}
		if (u.search) {
			for (const key of [...u.searchParams.keys()]) {
				if (/api[_-]?key|token|key|secret|password/i.test(key)) u.searchParams.set(key, "***");
			}
		}
		return u.toString();
	} catch {
		return url.replace(/:\/\/[^/\s]*:[^/\s@]*@/g, "://***@");
	}
}

function describeKeySource(
	spec: ApiProviderSpec,
	env: NodeJS.ProcessEnv,
	config: VisionConfig,
): string {
	if (env[spec.apiKeyEnv]) return `env (${spec.apiKeyEnv})`;
	if (config.provider === spec.id && config.apiKey.length > 0) return "config (apiKey)";
	if (getStoredProviderKey(spec.id)) return "keyring";
	return `missing (${spec.apiKeyEnv})`;
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

	// Key presence only (no network I/O): does the provider have a key?
	const probe = resolveModel(
		sanitized.provider,
		sanitized.modelId,
		opts.env ?? process.env,
		undefined,
		undefined,
		sanitized.apiKey,
	);
	const authNote = probe.ok
		? `provider "${sanitized.provider}" key present`
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
