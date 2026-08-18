/**
 * `vp provider` — provider registry + auth.
 *
 * Subcommands:
 *   list                 list configured providers + key presence
 *   check [<name>]       verify an API key is configured for a provider (or all)
 */

import type { VisionConfig } from "../core.ts";
import {
	deleteProviderKey,
	getStoredProviderKey,
	listStoredProviderKeys,
	storeProviderKey,
} from "../keyring.ts";
import { type ApiProviderSpec, getProvider, listProviders } from "../provider.ts";

/** Config slice needed to evaluate key presence from a plain-text config key. */
type ConfigApiKey = Pick<VisionConfig, "apiKey" | "provider">;

export interface ProviderResult {
	ok: boolean;
	message: string;
	code: number;
}

/**
 * A provider has a key when its env var, OS keyring, or (for the active
 * provider only) the config file's plain-text `apiKey` is set. The config key
 * is bound to `config.provider` in `resolveModel`'s precedence order, so it
 * only satisfies the active provider's check.
 */
function hasProviderKey(p: ApiProviderSpec, env: NodeJS.ProcessEnv, config: ConfigApiKey): boolean {
	if (env[p.apiKeyEnv]) return true;
	if (getStoredProviderKey(p.id)) return true;
	if (config.provider === p.id && config.apiKey.length > 0) return true;
	return false;
}

export function providerList(
	env: NodeJS.ProcessEnv = process.env,
	config: ConfigApiKey = { apiKey: "", provider: "" },
): ProviderResult {
	const lines: string[] = [];
	for (const p of listProviders()) {
		const hasKey = hasProviderKey(p, env, config);
		lines.push(
			`${p.id}  (${p.label})${p.supportsImage ? " [image]" : ""}  key: ${hasKey ? "present" : `missing (${p.apiKeyEnv})`}`,
		);
	}
	return { ok: true, message: lines.join("\n"), code: 0 };
}

export function providerCheck(
	name: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	config: ConfigApiKey = { apiKey: "", provider: "" },
): ProviderResult {
	const allSpecs = listProviders();
	const specs = name ? allSpecs.filter((p) => p.id === name) : allSpecs;
	if (specs.length === 0) {
		return { ok: false, message: `unknown provider "${name}"`, code: 1 };
	}
	const lines: string[] = [];
	let allOk = true;
	for (const spec of specs) {
		const hasKey = hasProviderKey(spec, env, config);
		if (hasKey) {
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

function requireProvider(providerId: string): ApiProviderSpec | undefined {
	return getProvider(providerId) as ApiProviderSpec | undefined;
}

function unknownProviderResult(providerId: string): ProviderResult {
	return {
		ok: false,
		message: `unknown provider "${providerId}". Known: ${listProviders()
			.map((p) => p.id)
			.join(", ")}`,
		code: 1,
	};
}

/**
 * Store a provider's API key in the OS keyring. The key is read from stdin so
 * it never appears in shell history or process listings.
 */
export async function providerStoreKey(
	providerId: string,
	readStdin: () => Promise<string> = () => readStdinDefault(),
): Promise<ProviderResult> {
	const spec = requireProvider(providerId);
	if (!spec) {
		return unknownProviderResult(providerId);
	}
	let apiKey = "";
	try {
		apiKey = (await readStdin()).replace(/\r?\n/g, "");
	} catch {
		apiKey = "";
	}
	if (!apiKey) {
		return { ok: false, message: "no key read from stdin", code: 1 };
	}
	const res = storeProviderKey(providerId, apiKey);
	if (!res.ok) {
		return { ok: false, message: res.error, code: 1 };
	}
	return {
		ok: true,
		message: `stored key for "${providerId}" in the system keyring.`,
		code: 0,
	};
}

/** Delete a provider's API key from the OS keyring. */
export function providerDeleteKey(providerId: string): ProviderResult {
	const spec = requireProvider(providerId);
	if (!spec) {
		return unknownProviderResult(providerId);
	}
	const res = deleteProviderKey(providerId);
	if (!res.ok) {
		return { ok: false, message: res.error, code: 1 };
	}
	return {
		ok: true,
		message: res.deleted
			? `deleted key for "${providerId}" from the system keyring.`
			: `no stored key for "${providerId}".`,
		code: 0,
	};
}

/** List providers that have a key stored in the OS keyring. */
export function providerListKeys(): ProviderResult {
	const stored = listStoredProviderKeys();
	const lines = stored.map((s) => {
		const hasKey = Boolean(getStoredProviderKey(s.providerId));
		return `${s.providerId}  key: ${hasKey ? "present" : "missing"}`;
	});
	if (lines.length === 0) {
		return { ok: true, message: "no keys stored in the keyring.", code: 0 };
	}
	return { ok: true, message: lines.join("\n"), code: 0 };
}

async function readStdinDefault(): Promise<string> {
	const { stdin } = process;
	if (!stdin || stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}
