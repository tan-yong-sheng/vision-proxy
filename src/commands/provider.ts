/**
 * `vp provider` — provider registry + auth.
 *
 * Subcommands:
 *   list                 list configured providers + key presence
 *   check [<name>]       verify an API key is configured for a provider (or all)
 *   test [<name>]        live text + vision probe against the provider
 */

import { generateText as defaultGenerateText, type ModelMessage } from "ai";
import { loadConfig } from "../config.ts";
import type { VisionConfig } from "../core.ts";
import { readImageFileWithReason } from "../core.ts";
import {
	deleteProviderKey,
	getStoredProviderKey,
	listStoredProviderKeys,
	storeProviderKey,
} from "../keyring.ts";
import { type ApiProviderSpec, getProvider, listProviders, resolveModel } from "../provider.ts";

/** Config slice needed to evaluate key presence from a plain-text config key. */
type ConfigApiKey = Pick<VisionConfig, "apiKey" | "provider">;

export interface ProviderResult {
	ok: boolean;
	message: string;
	code: number;
}

export const PROVIDER_TEST_PROMPT = "Reply with exactly: OK";

export const PROVIDER_TEST_VISION_PROMPT = "Describe this image in one word.";

export const PROVIDER_TEST_TEXT_TOKENS = 16;

export const PROVIDER_TEST_DEFAULT_TIMEOUT_MS = 30_000;

/** Embedded 1x1 transparent PNG used for the default vision probe (no fixture needed). */
export const PROVIDER_TEST_PIXEL_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type GenerateTextLike = (opts: {
	model: unknown;
	prompt?: string;
	messages?: unknown[];
	maxOutputTokens?: number;
	timeout?: number | { totalMs?: number };
	maxRetries?: number;
}) => Promise<{ text: string }>;

export interface ProviderTestOutcome {
	textOk: boolean;
	visionOk: boolean;
	textMs?: number;
	visionMs?: number;
	textError?: string;
	visionError?: string;
}

export interface ProviderTestOptions {
	provider?: string;
	model?: string;
	apiKey?: string;
	imagePath?: string;
	timeoutMs?: number;
	json?: boolean;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	configPath?: string;
	generateTextImpl?: GenerateTextLike;
	readImage?: (path: string) => Promise<{ data: string; mimeType: string } | { error: string }>;
}

/** Escape a literal for RegExp. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact credential-like fragments and cap length before surfacing a provider error.
 *
 * @tags provider, security, redact
 */
function sanitizeProbeError(raw: string, secrets: string[] = []): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips C0 controls before surfacing provider error
	let s = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
	for (const secret of secrets) {
		if (!secret) continue;
		s = s.replaceAll(secret, "***");
		const enc = encodeURIComponent(secret);
		if (enc !== secret) s = s.replaceAll(enc, "***");
	}
	s = s.replace(/:\/\/[^/\s]*:[^/\s@]*@/g, "://***@");
	s = s.replace(/([?&=](?:api[_-]?key|token|key|secret|password)=)[^&\s]+/gi, "$1***");
	s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***");
	s = s.replace(/sk-[A-Za-z0-9._-]+/g, "***");
	for (const secret of secrets) {
		if (!secret || secret.length < 4) continue;
		const pat = `${escapeRegExp(secret.slice(0, 4))}[A-Za-z0-9._\\-]*`;
		s = s.replace(new RegExp(pat, "g"), "***");
	}
	if (s.length > 500) s = `${s.slice(0, 500)}…`;
	return s;
}

/**
 * Classify a probe failure into an actionable one-liner. Never includes key
 * material; the caller renders the string verbatim.
 *
 * @tags provider, probe
 */
export function classifyProbeError(err: unknown, secrets: string[] = []): string {
	const raw = err instanceof Error ? err.message : String(err);
	const safe = sanitizeProbeError(raw, secrets);
	const msg = raw.toLowerCase();
	if (/\b401\b/.test(msg) || /unauthorized|invalid[^\n]*api[^\n]*key|incorrect api key/.test(msg)) {
		return `authentication failed (401): check the API key. ${safe}`;
	}
	if (/\b404\b/.test(msg) || /model[^\n]*not found|not_found/.test(msg)) {
		return `model not found (404): check --model and the provider base URL. ${safe}`;
	}
	if (/(image|vision)[^\n]*(not supported|unsupported)/.test(msg)) {
		return `model does not accept images: pick a vision-capable model. ${safe}`;
	}
	if (/\b400\b/.test(msg)) {
		return `request rejected (400): check --model and the prompt payload. ${safe}`;
	}
	if (/\b402\b/.test(msg) || /payment|quota|billing/.test(msg)) {
		return `quota or billing issue (402): check the provider account. ${safe}`;
	}
	if (/\b408\b/.test(msg) || /\b504\b/.test(msg) || /timed out|timeout|deadline/.test(msg)) {
		return `request timed out: the endpoint may be slow or unreachable. ${safe}`;
	}
	if (/\b429\b/.test(msg) || /rate[^\n]*limit/.test(msg)) {
		return `rate limited (429): wait and retry. ${safe}`;
	}
	if (
		/\b5\d\d\b/.test(msg) ||
		/internal server|bad gateway|service unavailable|overloaded/.test(msg)
	) {
		return `provider error: the model endpoint failed. ${safe}`;
	}
	if (/enotfound|econnrefused|econnreset|eai_again|network|fetch failed|socket/.test(msg)) {
		return `network error: check the base URL and connectivity. ${safe}`;
	}
	return safe;
}

async function defaultReadImage(
	path: string,
): Promise<{ data: string; mimeType: string } | { error: string }> {
	const r = await readImageFileWithReason(path);
	if (!r.image) return { error: "could not read image" };
	return { data: r.image.data, mimeType: r.image.mimeType };
}

interface ResolvedProbeTarget {
	providerId: string;
	modelRef: string;
	source: string;
	model: unknown;
	apiKey: string;
}

function keySourceLabel(
	spec: ApiProviderSpec,
	env: NodeJS.ProcessEnv,
	configApiKey: string,
	configProvider: string,
	explicitApiKey?: string,
): string {
	if (explicitApiKey) return "flag (--api-key)";
	if (env[spec.apiKeyEnv]) return `env (${spec.apiKeyEnv})`;
	if (getStoredProviderKey(spec.id)) return "keyring";
	if (configProvider === spec.id && configApiKey.length > 0) return "config (apiKey)";
	return "unknown";
}

function resolveProbeTarget(opts: {
	spec: ApiProviderSpec;
	env: NodeJS.ProcessEnv;
	modelId: string;
	explicitApiKey?: string;
	explicitBaseURL?: string;
	configApiKey: string;
	configProvider: string;
}): ResolvedProbeTarget | { error: string } {
	const resolved = resolveModel(
		opts.spec.id,
		opts.modelId,
		opts.env,
		opts.explicitApiKey,
		opts.explicitBaseURL,
		opts.configApiKey,
	);
	if (!resolved.ok) {
		return {
			error: `no API key for provider "${resolved.provider}". Set ${resolved.apiKeyEnv} (or pass --api-key).`,
		};
	}
	return {
		providerId: opts.spec.id,
		modelRef: `${opts.spec.id}/${opts.modelId}`,
		source: keySourceLabel(
			opts.spec,
			opts.env,
			opts.configApiKey,
			opts.configProvider,
			opts.explicitApiKey,
		),
		model: resolved.model.model,
		apiKey: resolved.model.apiKey ?? "",
	};
}

function probeTimeout(opts: { timeoutMs?: number }): { value: number; error?: string } {
	if (opts.timeoutMs === undefined) return { value: PROVIDER_TEST_DEFAULT_TIMEOUT_MS };
	if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
		return {
			value: PROVIDER_TEST_DEFAULT_TIMEOUT_MS,
			error: "--timeout must be a positive number of ms",
		};
	}
	return { value: Math.floor(opts.timeoutMs) };
}

async function runSingleProbe(
	generateTextImpl: GenerateTextLike,
	call: {
		model: unknown;
		prompt?: string;
		messages?: unknown[];
		maxOutputTokens: number;
		timeout: number;
	},
	timer?: () => number,
): Promise<{ text: string; ms: number }> {
	const now = timer ?? Date.now;
	const start = now();
	const result = await generateTextImpl({
		model: call.model,
		...(call.prompt !== undefined ? { prompt: call.prompt } : {}),
		...(call.messages !== undefined ? { messages: call.messages } : {}),
		maxOutputTokens: call.maxOutputTokens,
		timeout: call.timeout,
		maxRetries: 0,
	});
	return { text: result.text, ms: Math.max(0, now() - start) };
}

function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function visionMessage(image: { data: string; mimeType: string }): ModelMessage[] {
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: PROVIDER_TEST_VISION_PROMPT },
				{
					type: "file",
					data: Buffer.from(image.data, "base64"),
					mediaType: image.mimeType,
				},
			],
		},
	];
}

/**
 * Two-stage live connectivity probe: text first, then vision. Never touches
 * the description cache and never prints key material.
 *
 * The text and vision outcomes stay separate so a text-only endpoint reports
 * `TEXT OK / VISION FAIL` instead of a single pass/fail.
 *
 * @tags provider, probe
 */
export async function providerTest(opts: ProviderTestOptions = {}): Promise<ProviderResult> {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();
	const { config } = await loadConfig({
		explicitConfigPath: opts.configPath,
		cwd,
		env,
	});
	const providerId = opts.provider ?? config.provider;
	const spec = getProvider(providerId);
	if (!spec) {
		return {
			ok: false,
			message: `unknown provider "${providerId}". Known: ${listProviders()
				.map((p) => p.id)
				.join(", ")}`,
			code: 1,
		};
	}
	const modelId =
		opts.model ??
		(opts.provider && opts.provider !== config.provider ? spec.defaultModelId : config.modelId);
	const timeout = probeTimeout({ timeoutMs: opts.timeoutMs });
	if (timeout.error) {
		return { ok: false, message: timeout.error, code: 1 };
	}
	const target = resolveProbeTarget({
		spec,
		env,
		modelId,
		explicitApiKey: opts.apiKey,
		explicitBaseURL:
			opts.provider && opts.provider !== config.provider ? undefined : config.baseUrl || undefined,
		configApiKey: config.apiKey,
		configProvider: config.provider,
	});
	if ("error" in target) {
		return { ok: false, message: target.error, code: 1 };
	}
	let image = { data: PROVIDER_TEST_PIXEL_BASE64, mimeType: "image/png" };
	if (opts.imagePath) {
		const read = await (opts.readImage ?? defaultReadImage)(opts.imagePath);
		if ("error" in read) {
			return { ok: false, message: `could not read --image: ${read.error}`, code: 1 };
		}
		image = { data: read.data, mimeType: read.mimeType };
	}
	const generateTextImpl =
		opts.generateTextImpl ?? (defaultGenerateText as unknown as GenerateTextLike);
	const outcome: ProviderTestOutcome = { textOk: false, visionOk: false };
	try {
		const text = await runSingleProbe(generateTextImpl, {
			model: target.model,
			prompt: PROVIDER_TEST_PROMPT,
			maxOutputTokens: PROVIDER_TEST_TEXT_TOKENS,
			timeout: timeout.value,
		});
		outcome.textOk = true;
		outcome.textMs = text.ms;
	} catch (err) {
		outcome.textOk = false;
		outcome.textError = classifyProbeError(err, target.apiKey ? [target.apiKey] : []);
	}
	try {
		const vision = await runSingleProbe(generateTextImpl, {
			model: target.model,
			messages: visionMessage(image),
			maxOutputTokens: PROVIDER_TEST_TEXT_TOKENS,
			timeout: timeout.value,
		});
		outcome.visionOk = true;
		outcome.visionMs = vision.ms;
	} catch (err) {
		outcome.visionOk = false;
		outcome.visionError = classifyProbeError(err, target.apiKey ? [target.apiKey] : []);
	}
	const ok = outcome.textOk && outcome.visionOk;
	if (opts.json) {
		return {
			ok,
			message: JSON.stringify(
				{
					provider: target.providerId,
					model: target.modelRef,
					source: target.source,
					text: outcome.textOk
						? { status: "OK", latencyMs: outcome.textMs }
						: { status: "FAIL", error: outcome.textError },
					vision: outcome.visionOk
						? { status: "OK", latencyMs: outcome.visionMs }
						: { status: "FAIL", error: outcome.visionError },
				},
				null,
				2,
			),
			code: ok ? 0 : 1,
		};
	}
	const lines = [
		`Source: ${target.source}`,
		`Model: ${target.modelRef}`,
		outcome.textOk
			? `Text: OK (${formatSeconds(outcome.textMs ?? 0)})`
			: `Text: FAIL (${outcome.textError})`,
		outcome.visionOk
			? `Vision: OK (${formatSeconds(outcome.visionMs ?? 0)})`
			: `Vision: FAIL (${outcome.visionError})`,
		ok ? "Connection test successful" : "Connection test failed",
	];
	return { ok, message: lines.join("\n"), code: ok ? 0 : 1 };
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
