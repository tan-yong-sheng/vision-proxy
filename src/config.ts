/**
 * CLI config resolution.
 *
 * Precedence (highest to lowest):
 *   1. CLI flags (applied by callers above the loaded config, e.g.
 *      --provider / --model / --api-key in the analyze pipeline)
 *   2. Explicit --config <path> file
 *   3. Environment overrides (VP_* + provider env vars)
 *   4. Project .vision-proxy.json in cwd
 *   5. User ~/.vision-proxy/config.json
 *   6. Built-in defaults
 *
 * `readEnvOverrides` + `resolveLayeredConfig` in core.ts apply the layer
 * stack; this module reads the file layers and exposes a single
 * `loadConfig` entry point used by every command.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
	envOverrideNames,
	readPersistentFile,
	resolveLayeredConfig,
	type VisionConfig,
} from "./core.ts";

export interface LoadedConfig {
	config: VisionConfig;
	/**
	 * Layer stack that contributed to the result, highest first (e.g.
	 * "explicit:/path > env(VP_MODEL) > project:.vision-proxy.json >
	 * defaults"). CLI flags are applied by callers above this stack and never
	 * appear here.
	 */
	resolvedFrom: string;
}

function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".vision-proxy.json");
}

export async function readJsonFile(file: string): Promise<Partial<VisionConfig> | null> {
	try {
		const raw = await fs.readFile(file, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") return parsed as Partial<VisionConfig>;
	} catch {
		// Missing or invalid.
	}
	return null;
}

function isNonEmpty(
	layer: Partial<VisionConfig> | null | undefined,
): layer is Partial<VisionConfig> {
	return !!layer && Object.keys(layer).length > 0;
}

/** Describe the contributing layers, highest first, for diagnostics. */
function describeLayers(parts: {
	explicitPath?: string;
	explicitFile?: Partial<VisionConfig>;
	envKeys: string[];
	project?: Partial<VisionConfig> | null;
	user?: Partial<VisionConfig> | null;
}): string {
	const stack: string[] = [];
	if (parts.explicitPath && isNonEmpty(parts.explicitFile)) {
		stack.push(`explicit:${parts.explicitPath}`);
	}
	if (parts.envKeys.length > 0) stack.push(`env(${parts.envKeys.join(",")})`);
	if (isNonEmpty(parts.project)) stack.push("project:.vision-proxy.json");
	if (isNonEmpty(parts.user)) stack.push("user:~/.vision-proxy/config.json");
	stack.push("defaults");
	return stack.join(" > ");
}

/**
 * Load the effective config, layering explicit file > env > project > user >
 * defaults. CLI flags stay above: callers apply them over the returned
 * config and they never appear in `resolvedFrom`.
 */
export async function loadConfig(
	opts: { explicitConfigPath?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LoadedConfig> {
	const cwd = opts.cwd ?? process.cwd();
	const env = opts.env ?? process.env;
	const envKeys = envOverrideNames(env);

	const user = (await readPersistentFile()) ?? {};
	const project = (await readJsonFile(projectConfigPath(cwd))) ?? {};
	if (opts.explicitConfigPath) {
		const explicitFile = (await readJsonFile(opts.explicitConfigPath)) ?? {};
		const config = resolveLayeredConfig({ user, project, explicitFile, env });
		return {
			config,
			resolvedFrom: describeLayers({
				explicitPath: opts.explicitConfigPath,
				explicitFile,
				envKeys,
				project,
				user,
			}),
		};
	}

	const config = resolveLayeredConfig({ user, project, env });
	return { config, resolvedFrom: describeLayers({ envKeys, project, user }) };
}
