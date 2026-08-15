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

export interface ProviderSpec {
	id: string;
	label: string;
	/** Environment variable that holds the API key. */
	apiKeyEnv: string;
	/** Optional base URL override env var. */
	baseUrlEnv?: string;
	/** Factory: build a LanguageModel from the resolved key + model id. */
	make: (opts: { apiKey: string; modelId: string; baseURL?: string }) => LanguageModel;
	/** Whether the provider supports image input by default. */
	supportsImage: boolean;
	/** Default model id used for probes and fallbacks. */
	defaultModelId: string;
}

const openaiProvider: ProviderSpec = {
	id: "openai",
	label: "OpenAI",
	apiKeyEnv: "OPENAI_API_KEY",
	baseUrlEnv: "OPENAI_BASE_URL",
	supportsImage: true,
	defaultModelId: "gpt-4o",
	make: ({ apiKey, modelId, baseURL }) =>
		createOpenAI({ apiKey, baseURL })(modelId),
};

const anthropicProvider: ProviderSpec = {
	id: "anthropic",
	label: "Anthropic",
	apiKeyEnv: "ANTHROPIC_API_KEY",
	baseUrlEnv: "ANTHROPIC_BASE_URL",
	supportsImage: true,
	defaultModelId: "claude-sonnet-4-5",
	make: ({ apiKey, modelId, baseURL }) =>
		createAnthropic({ apiKey, baseURL })(modelId),
};

const googleProvider: ProviderSpec = {
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
};

export function listProviders(): ProviderSpec[] {
	return Object.values(PROVIDERS);
}

export function getProvider(id: string): ProviderSpec | undefined {
	return PROVIDERS[id];
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

export type ResolveModelOutcome = ResolveModelResult | ResolveModelMissingKey;

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
	const provider = PROVIDERS[providerId];
	if (!provider) {
		// Unknown provider: synthesize a missing-key outcome so callers can report it.
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

/** Check whether a resolved provider list contains a given provider id. */
export function isKnownProvider(id: string): boolean {
	return id in PROVIDERS;
}
