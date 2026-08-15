/**
 * CLI config resolution.
 *
 * Precedence (highest to lowest):
 *   1. Explicit --config <path> file
 *   2. Project .vision-proxy.json in cwd
 *   3. User ~/.vision-proxy/config.json
 *   4. Environment overrides (VP_* + OPENAI_API_KEY etc.)
 *   5. Built-in defaults
 *
 * `readEnvOverrides` + `resolveConfig` in core.ts apply the lowest layers; this
 * module layers the file lookups above them and exposes a single
 * `loadConfig` entry point used by every command.
 */
import {
	resolveConfig,
	readPersistentFile,
	type VisionConfig,
} from "./core.ts";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface LoadedConfig {
	config: VisionConfig;
	/** Which source won, last-applied, for diagnostics. */
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

/** Load the effective config, layering explicit > project > user > env > default. */
export async function loadConfig(opts: {
	explicitConfigPath?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
} = {}): Promise<LoadedConfig> {
	const cwd = opts.cwd ?? process.cwd();
	const env = opts.env ?? process.env;

	let fileConfig: Partial<VisionConfig> = {};
	let resolvedFrom = "defaults";

	if (opts.explicitConfigPath) {
		const explicit = await readJsonFile(opts.explicitConfigPath);
		if (explicit) {
			fileConfig = explicit;
			resolvedFrom = `explicit:${opts.explicitConfigPath}`;
		}
	} else {
		const user = await readPersistentFile();
		const project = await readJsonFile(projectConfigPath(cwd));
		if (user && Object.keys(user).length > 0) {
			fileConfig = { ...fileConfig, ...user };
			resolvedFrom = "user:~/.vision-proxy/config.json";
		}
		if (project && Object.keys(project).length > 0) {
			fileConfig = { ...fileConfig, ...project };
			resolvedFrom = "project:.vision-proxy.json";
		}
	}

	const config = resolveConfig(env, fileConfig);
	return { config, resolvedFrom };
}
