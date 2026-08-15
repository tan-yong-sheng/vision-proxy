/**
 * Optional keyring credential storage for vision-proxy.
 *
 * API keys are normally read from the environment (e.g. OPENAI_API_KEY). As a
 * convenience, they can instead be stored in the OS keyring via the optional
 * `@napi-rs/keyring` native binding, then resolved transparently during
 * provider resolution.
 *
 * The binding is optional: it is never imported at module load. `getKeyringBackend`
 * lazily requires it on first use and degrades to `null` when the binding is
 * missing (e.g. optional-dependency install skipped) or disabled via
 * `VP_KEYRING=0`. Tests inject a fake backend via `setKeyringBackend`.
 *
 * Keyring is the lowest-precedence source: an explicit `--api-key` flag or an
 * environment variable always wins, so stored credentials are only used as a
 * fallback.
 */
import { createRequire } from "node:module";

/** Keyring service namespace for all vision-proxy entries. */
export const KEYRING_SERVICE = "vision-proxy";

/** Entry-account prefix so `listKeys` can tell our entries apart. */
export const PROVIDER_KEY_PREFIX = "vp:";

export function providerKeyAccount(providerId: string): string {
	return `${PROVIDER_KEY_PREFIX}${providerId}`;
}

/** Minimal structural shape of the platform keyring we rely on. */
export interface KeyringBackend {
	/** Return the stored secret, or null when none/blocked. */
	get(account: string): string | null;
	/** Persist a secret. */
	set(account: string, secret: string): void;
	/** Remove the stored secret; returns false when none existed. */
	delete(account: string): boolean;
	/** List all stored account names for the service. */
	list(): string[];
}

/**
 * Override used by tests and (internally) to cache the resolved backend.
 * `undefined` means "not yet determined"; `null` means "determined
 * unavailable".
 */
let backendOverride: KeyringBackend | null | undefined;

/** Replace the active backend (tests call this; pass `null` to force-unavailable). */
export function setKeyringBackend(backend: KeyringBackend | null): void {
	backendOverride = backend;
}

function keyringDisabled(): boolean {
	const v = process.env.VP_KEYRING;
	return v === "0" || v === "false" || v === "off";
}

interface KeyringModule {
	Entry: new (
		service: string,
		username: string,
	) => {
		setPassword(password: string): void;
		getPassword(): string | null;
		deletePassword(): boolean;
	};
	findCredentials(service: string): Array<{ account: string; password: string }>;
}

function loadDefaultBackend(): KeyringBackend | null {
	if (keyringDisabled()) return null;
	try {
		const require = createRequire(import.meta.url);
		const mod = require("@napi-rs/keyring") as KeyringModule;
		return {
			get(account) {
				try {
					return new mod.Entry(KEYRING_SERVICE, account).getPassword();
				} catch {
					return null;
				}
			},
			set(account, secret) {
				new mod.Entry(KEYRING_SERVICE, account).setPassword(secret);
			},
			delete(account) {
				try {
					return new mod.Entry(KEYRING_SERVICE, account).deletePassword();
				} catch {
					return false;
				}
			},
			list() {
				try {
					return mod.findCredentials(KEYRING_SERVICE).map((c) => c.account);
				} catch {
					return [];
				}
			},
		};
	} catch {
		return null;
	}
}

/** Resolve the active backend, caching a successful load for the process. */
export function getKeyringBackend(): KeyringBackend | null {
	if (backendOverride !== undefined) return backendOverride;
	const backend = loadDefaultBackend();
	if (backend) backendOverride = backend;
	return backend;
}

/** Whether a usable keyring backend is present. */
export function keyringAvailable(): boolean {
	return getKeyringBackend() !== null;
}

/** Store a provider API key in the keyring. */
export function storeProviderKey(
	providerId: string,
	apiKey: string,
): { ok: true } | { ok: false; error: string } {
	const backend = getKeyringBackend();
	if (!backend) {
		return {
			ok: false,
			error: "keyring storage unavailable (native binding missing or disabled via VP_KEYRING=0)",
		};
	}
	try {
		backend.set(providerKeyAccount(providerId), apiKey);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Read a stored provider API key, or undefined when none/blocked. */
export function getStoredProviderKey(providerId: string): string | undefined {
	const backend = getKeyringBackend();
	if (!backend) return undefined;
	try {
		const v = backend.get(providerKeyAccount(providerId));
		return v && v.length > 0 ? v : undefined;
	} catch {
		return undefined;
	}
}

/** Delete a stored provider API key. */
export function deleteProviderKey(
	providerId: string,
): { ok: true; deleted: boolean } | { ok: false; deleted: false; error: string } {
	const backend = getKeyringBackend();
	if (!backend) {
		return {
			ok: false,
			deleted: false,
			error: "keyring storage unavailable (native binding missing or disabled via VP_KEYRING=0)",
		};
	}
	try {
		const deleted = backend.delete(providerKeyAccount(providerId));
		return { ok: true, deleted };
	} catch (err) {
		return { ok: false, deleted: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export interface StoredProviderKey {
	providerId: string;
	account: string;
}

/** List provider keys stored in the keyring. */
export function listStoredProviderKeys(): StoredProviderKey[] {
	const backend = getKeyringBackend();
	if (!backend) return [];
	try {
		return backend
			.list()
			.filter((account) => account.startsWith(PROVIDER_KEY_PREFIX))
			.map((account) => ({
				account,
				providerId: account.slice(PROVIDER_KEY_PREFIX.length),
			}));
	} catch {
		return [];
	}
}
