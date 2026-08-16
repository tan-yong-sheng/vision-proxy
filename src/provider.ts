/**
 * Provider registry for the vision-proxy CLI.
 *
 * Replaces Pi's `modelRegistry` + `getApiKeyAndHeaders`. The Vercel AI SDK
 * needs the API key at provider construction, so the CLI owns a small registry
 * that maps a provider id to a language-model factory and resolves the key from
 * the environment (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY) or an explicit flag.
 */
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getStoredProviderKey } from "./keyring.ts";

/** Discriminated union for API-key-backed providers (openai, anthropic, google). */
export interface ApiProviderSpec {
	id: "openai" | "anthropic" | "google";
	label: string;
	apiKeyEnv: string;
	baseUrlEnv?: string;
	make: (opts: { apiKey: string; modelId: string; baseURL?: string }) => LanguageModel;
	supportsImage: boolean;
	defaultModelId: string;
}

interface AcpProviderSpec {
	id: "acp";
	label: string;
	supportsImage: boolean;
	defaultModelId: string;
}

export type ProviderSpec = ApiProviderSpec | AcpProviderSpec;

const openaiProvider: ApiProviderSpec = {
	id: "openai",
	label: "OpenAI",
	apiKeyEnv: "OPENAI_API_KEY",
	baseUrlEnv: "OPENAI_BASE_URL",
	supportsImage: true,
	defaultModelId: "gpt-4o",
	make: ({ apiKey, modelId, baseURL }) =>
		createOpenAI({ apiKey, baseURL })(modelId),
};

const anthropicProvider: ApiProviderSpec = {
	id: "anthropic",
	label: "Anthropic",
	apiKeyEnv: "ANTHROPIC_API_KEY",
	baseUrlEnv: "ANTHROPIC_BASE_URL",
	supportsImage: true,
	defaultModelId: "claude-sonnet-4-5",
	make: ({ apiKey, modelId, baseURL }) =>
		createAnthropic({ apiKey, baseURL })(modelId),
};

const googleProvider: ApiProviderSpec = {
	id: "google",
	label: "Google",
	apiKeyEnv: "GOOGLE_API_KEY",
	baseUrlEnv: "GOOGLE_BASE_URL",
	supportsImage: true,
	defaultModelId: "gemini-2.5-pro",
	make: ({ apiKey, modelId, baseURL }) =>
		createGoogleGenerativeAI({ apiKey, baseURL })(modelId),
};

const PROVIDERS: Record<string, ProviderSpec> = {
	[openaiProvider.id]: openaiProvider,
	[anthropicProvider.id]: anthropicProvider,
	[googleProvider.id]: googleProvider,
	"acp": {
		id: "acp",
		label: "ACP (Agent Client Protocol)",
		supportsImage: true,
		defaultModelId: "",
	} as unknown as ProviderSpec,
};

export function listProviders(): ProviderSpec[] {
	return Object.values(PROVIDERS);
}

export function getProvider(id: string): ApiProviderSpec | undefined {
	return PROVIDERS[id] as ApiProviderSpec | undefined;
}

export function isAcpProvider(spec: ProviderSpec): spec is AcpProviderSpec {
	return spec.id === "acp";
}

export interface ResolvedModel {
	provider: ProviderSpec;
	modelId: string;
	apiKey: string | undefined;
	baseURL: string | undefined;
	model: LanguageModel;
}

export interface ResolveModelResult {
	ok: true;
	model: ResolvedModel;
	missingKey: false;
}

export interface ResolveModelMissingKey {
	ok: false;
	missingKey: true;
	provider: string;
	apiKeyEnv: string;
}

export interface ResolveModelAcp {
	ok: true;
	model: ResolvedModel;
	missingKey: false;
	provider: "acp";
}

export type ResolveModelOutcome = ResolveModelResult | ResolveModelMissingKey | ResolveModelAcp;

function envValue(name: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (!name) return undefined;
	const v = env[name];
	return v && v.length > 0 ? v : undefined;
}

/** Resolve a provider + model id into a constructed LanguageModel. */
export function resolveModel(
	providerId: string,
	modelId: string,
	env: NodeJS.ProcessEnv = process.env,
	explicitApiKey?: string,
	explicitBaseURL?: string,
): ResolveModelOutcome {
	const provider = PROVIDERS[providerId] as ApiProviderSpec | undefined;
	if (!provider) {
		return {
			ok: false,
			missingKey: true,
			provider: providerId,
			apiKeyEnv: `${providerId.toUpperCase()}_API_KEY`,
		};
	}
	const apiKey =
		explicitApiKey ?? envValue(provider.apiKeyEnv, env) ?? getStoredProviderKey(providerId);
	const baseURL = envValue(provider.baseUrlEnv, env) ?? explicitBaseURL;
	if (!apiKey) {
		return {
			ok: false,
			missingKey: true,
			provider: provider.id,
			apiKeyEnv: provider.apiKeyEnv,
		};
	}
	return {
		ok: true,
		missingKey: false,
		model: {
			provider,
			modelId,
			apiKey,
			baseURL,
			model: provider.make({ apiKey, modelId, baseURL }),
		},
	};
}

/** Resolve an ACP provider with its command/args/cwd/mcpServers config. */
export async function resolveAcpModel(
	config: {
		command: string;
		args?: string[];
		cwd?: string;
		mcpServers?: unknown[];
	},
): Promise<{ ok: true; model: LanguageModel } | { ok: false; error: string }> {
	try {
		const { createACPProvider } = await import("@mcpc-tech/acp-ai-provider");
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const provider = createACPProvider({
			command: config.command,
			args: config.args ?? [],
			env: process.env as Record<string, string>,
			session: {
				cwd: config.cwd ?? process.cwd(),
				// mcpServers shape varies; pass through as opaque
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				mcpServers: config.mcpServers ?? ({} as any[]),
			},
		});
		const model = provider.languageModel();
		return { ok: true, model };
	} catch (err) {
		return {
			ok: false,
			error: `failed to initialize ACP provider: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/** Check whether a resolved provider list contains a given provider id. */
export function isKnownProvider(id: string): boolean {
	return id in PROVIDERS;
}
