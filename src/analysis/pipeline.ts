/**
 * Analysis pipeline — the coordination flow for `vp analyze`.
 *
 * Owns the end-to-end flow: config resolution, image intake/read/hash/crop,
 * cache-first single + joint multi-image policy, provider/model dispatch via
 * the Vercel AI SDK adapter, and safe fenced rendering. Callers (`cli.ts`
 * via `commands/analyze.ts`) learn one flow; implementation details stay
 * behind this seam in `core.ts`, `config.ts`, `cache.ts`, `adapter.ts`, and
 * `provider.ts`, which remain the focused implementation files.
 */

import { analyzeImagesWithModel } from "../adapter.ts";
import { cacheGet, cacheSet, configureCache } from "../cache.ts";
import { loadConfig } from "../config.ts";
import {
	buildAnalyzeResult,
	buildGroundingInstruction,
	buildJointDescriptionFence,
	buildToolCacheKey,
	type CropEntry,
	cropSignature,
	type GroundingFormat,
	getGroundingFormat,
	hashImageData,
	type ImagePayload,
	intakeImage,
	parseCropArg,
	truncateContext,
} from "../core.ts";
import { isKnownProvider, resolveModel } from "../provider.ts";
import type { AnalyzeFlags, AnalyzeOutcome } from "./types.ts";

export type { AnalyzeFlags, AnalyzeOutcome };

/**
 * Run analyze. Returns the outcome (does not print). The CLI layer decides how
 * to render stdout.
 */
export async function runAnalyze(
	imagePaths: string[],
	flags: AnalyzeFlags,
	analyzeImpl: typeof analyzeImagesWithModel = analyzeImagesWithModel,
): Promise<AnalyzeOutcome> {
	const env = flags.env ?? process.env;
	const cwd = flags.cwd ?? process.cwd();

	const { config } = await loadConfig({ explicitConfigPath: flags.configPath, cwd, env });
	configureCache(config.cacheSize, undefined, config.cacheMaxAgeDays);

	if (imagePaths.length > config.maxImagesPerCall) {
		throw new AnalyzeError(
			`too many images (${imagePaths.length}). Maximum is ${config.maxImagesPerCall}.`,
		);
	}

	const provider = flags.provider ?? config.provider;
	const modelId = flags.model ?? config.modelId;

	if (!isKnownProvider(provider)) {
		throw new AnalyzeError(`unknown provider "${provider}"`);
	}

	// The model must be resolvable (have a key); a missing key is fatal.
	const modelOutcome = resolveModel(
		provider,
		modelId,
		env,
		flags.apiKey,
		config.baseUrl,
		config.apiKey,
	);
	if (!modelOutcome.ok) {
		throw new AnalyzeError(
			`no API key for provider "${modelOutcome.provider}". Set ${modelOutcome.apiKeyEnv} (or pass --api-key).`,
		);
	}
	const grounding = getGroundingFormat(config, provider, modelId);
	const effectiveFormat: GroundingFormat =
		flags.format && flags.format !== "none" ? flags.format : grounding;
	const systemPrompt = config.systemPrompt + buildGroundingInstruction(effectiveFormat);

	// Read + hash + crop payloads.
	const payloads: ImagePayload[] = [];
	for (let i = 0; i < imagePaths.length; i++) {
		const cropForIndex = flags.crops?.find((c) => c.image_index === i);
		const taken = await intakeImage(imagePaths[i]!, cropForIndex);
		if ("error" in taken) throw new AnalyzeError(taken.error);
		payloads.push(taken);
	}

	const question = flags.question ?? "";
	const context = config.includeContext ? truncateContext(flags.context?.trim() ?? "") : "";
	const promptHash = hashImageData(JSON.stringify([question, context]));

	// Unified cache-first dispatch. The single-image default path and the
	// joint multi-image path (explicit --joint, or multiple images) differ
	// only in key formula, fence renderer, and per-image records, so they
	// share one cache -> analyze -> fence flow. Key shapes (including the
	// `&f=<format>` segment) are pinned by `src/analysis/cache-keys.test.ts`.
	const single = !flags.joint && payloads.length === 1;
	let cropSig: string | undefined;
	if (single) {
		const crop = payloads[0]!.crop;
		cropSig = crop ? cropSignature(crop) : undefined;
	} else {
		const perImage = payloads.map((p) => (p.crop ? cropSignature(p.crop) : "full")).join("+");
		cropSig = flags.joint ? `joint:${perImage}` : perImage;
	}
	const cacheKey = buildToolCacheKey(
		payloads.map((p) => p.hash),
		cropSig,
		promptHash,
		`${provider}/${modelId}`,
		effectiveFormat,
	);
	const fenceDescription = (description: string): string => {
		if (!flags.fence) return description;
		return single
			? buildAnalyzeResult([payloads[0]!], description, effectiveFormat)
			: buildJointDescriptionFence(
					payloads.map((p) => ({ hash: p.hash, meta: p.meta })),
					description,
					effectiveFormat,
				);
	};
	const toRecords = (description: string) => payloads.map((p) => ({ hash: p.hash, description }));

	const cached = await cacheGet(cacheKey);
	if (cached !== undefined) {
		return { output: fenceDescription(cached), cacheHit: true, records: toRecords(cached) };
	}

	const resp = await analyzeImpl({
		imagePayloads: payloads,
		model: modelOutcome.model.model,
		systemPrompt,
		question,
		context: context ? context : undefined,
		maxOutputTokens: flags.maxOutputTokens,
	});
	const description = resp.text;
	await cacheSet(cacheKey, description);
	return {
		output: fenceDescription(description),
		cacheHit: false,
		records: toRecords(description),
	};
}

/** Parse `--crop` flags (now in the parsed flags map) in the form `<index>:<form>`. */
export function parseCropFlags(flags: Record<string, string | boolean | string[]>): {
	crops: CropEntry[] | undefined;
} {
	const raw = flags.crop;
	if (raw === undefined) return { crops: undefined };
	const values = Array.isArray(raw) ? raw : [raw];
	const crops: CropEntry[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const parsed = parseCropArg(value);
		if (typeof parsed === "string") throw new AnalyzeError(parsed);
		crops.push(parsed);
	}
	return { crops: crops.length > 0 ? crops : undefined };
}

export class AnalyzeError extends Error {}
