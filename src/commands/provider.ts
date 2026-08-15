/**
 * `vp provider` — provider registry + auth.
 *
 * Subcommands:
 *   list                 list configured providers + key presence
 *   check [<name>]       verify an API key is configured for a provider (or all)
 */

import {
	deleteProviderKey,
	getStoredProviderKey,
	listStoredProviderKeys,
	storeProviderKey,
} from "../keyring.ts";
import { getProvider, listProviders, type ProviderSpec, resolveModel } from "../provider.ts";

export interface ProviderResult {
	ok: boolean;
	message: string;
	code: number;
}

export function providerList(env: NodeJS.ProcessEnv = process.env): ProviderResult {
	const lines: string[] = [];
	for (const p of listProviders()) {
		const hasKey = Boolean(env[p.apiKeyEnv]) || Boolean(getStoredProviderKey(p.id));
		lines.push(
			`${p.id}  (${p.label})${p.supportsImage ? " [image]" : ""}  key: ${hasKey ? "present" : "missing (" + p.apiKeyEnv + ")"}`,
		);
	}
	return { ok: true, message: lines.join("\n"), code: 0 };
}

export function providerCheck(
	name: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ProviderResult {
	const specs = name ? ([getProvider(name)].filter(Boolean) as ProviderSpec[]) : listProviders();
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

function requireProvider(providerId: string): ProviderSpec | undefined {
	return getProvider(providerId);
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
