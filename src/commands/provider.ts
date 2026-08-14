/**
 * `vp provider` — provider registry + auth.
 *
 * Subcommands:
 *   list                 list configured providers + key presence
 *   add <name>           register a provider + key/env (writes ~/.vision-proxy/config.json)
 *   check [<name>]       verify auth for a provider (or all)
 */
import {
	getProvider,
	listProviders,
	resolveModel,
	type ProviderSpec,
} from "../provider.ts";
import { readJsonFile } from "../config.ts";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

export interface ProviderResult {
	ok: boolean;
	message: string;
	code: number;
}

function userConfigPath(baseDir: string = os.homedir()): string {
	return path.join(baseDir, ".vision-proxy", "config.json");
}

export function providerList(env: NodeJS.ProcessEnv = process.env): ProviderResult {
	const lines: string[] = [];
	for (const p of listProviders()) {
		const hasKey = Boolean(env[p.apiKeyEnv]);
		lines.push(
			`${p.id}  (${p.label})${p.supportsImage ? " [image]" : ""}  key: ${hasKey ? "present" : "missing (" + p.apiKeyEnv + ")"}`,
		);
	}
	return { ok: true, message: lines.join("\n"), code: 0 };
}

export async function providerAdd(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	baseDir: string = os.homedir(),
): Promise<ProviderResult> {
	// We only register known providers; registration means recording that the
	// CLI should use it as the active provider and rely on the env key.
	const spec: ProviderSpec | undefined = getProvider(name);
	if (!spec) {
		return {
			ok: false,
			message: `unknown provider "${name}". Known: ${listProviders().map((p) => p.id).join(", ")}`,
			code: 1,
		};
	}
	const target = userConfigPath(baseDir);
	const existing: Record<string, unknown> = (await readJsonFile(target)) ?? {};
	existing.provider = spec.id;
	if (spec.id === "openai" || spec.id === "anthropic") {
		// No model id change required; the user sets model via --model or config set.
	}
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, JSON.stringify(existing, null, 2) + "\n", "utf8");
	const keyHint = env[spec.apiKeyEnv]
		? "key detected in environment"
		: `remember to set ${spec.apiKeyEnv}`;
	return {
		ok: true,
		message: `registered provider "${spec.id}" in ${target}. ${keyHint}.`,
		code: 0,
	};
}

export function providerCheck(
	name: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ProviderResult {
	const specs = name ? [getProvider(name)].filter(Boolean) as ProviderSpec[] : listProviders();
	if (specs.length === 0) {
		return { ok: false, message: `unknown provider "${name}"`, code: 1 };
	}
	const lines: string[] = [];
	let allOk = true;
	for (const spec of specs) {
		// Check auth using the configured default model for that provider.
		const probe = resolveModel(spec.id, spec.defaultModelId, env);
		if (probe.ok) {
			lines.push(`${spec.id}: OK (key present)`);
		} else {
			allOk = false;
			lines.push(`${spec.id}: MISSING KEY (${spec.apiKeyEnv})`);
		}
	}
	return {
		ok: allOk,
		message: lines.join("\n"),
		code: allOk ? 0 : 1,
	};
}
