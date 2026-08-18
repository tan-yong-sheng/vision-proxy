/**
 * `vp analyze` — core image analysis command.
 *
 * Flow:
 *   - Resolve config (file + env + flags).
 *   - Read + hash + (optionally) crop each image.
 *   - Cache-first: for the single-image default path, look up a cached
 *     description keyed by content hash + crop + question + model ref.
 *   - Otherwise call the Vercel AI SDK via the adapter.
 *   - Emit a fenced description (`<vision_proxy_description>`), unless
 *     `--no-fence` was passed. The fence is ON by default; image-derived text
 *     is attacker-controlled, so unfenced output must never be injected.
 */

import { type AnalyzeRequest, analyzeImagesWithModel } from "../adapter.ts";
import { cacheGet, cacheSet, configureCache } from "../cache.ts";
import { loadConfig } from "../config.ts";
import {
	_imageMeta,
	buildAnalyzeResult,
	buildGroundingInstruction,
	buildJointDescriptionFence,
	buildToolCacheKey,
	type CropEntry,
	cropImage,
	cropSignature,
	describeReadReason,
	type GroundingFormat,
	getGroundingFormat,
	hashImageData,
	type ImageContent,
	type ImagePayload,
	parseCropArg,
	parseModelString,
	readImageFileWithReason,
	resolveCropEntry,
	storeImageMeta,
} from "../core.ts";
import { isKnownProvider, resolveModel } from "../provider.ts";

export interface AnalyzeFlags {
	format?: GroundingFormat;
	provider?: string;
	model?: string;
	joint?: boolean;
	crops?: CropEntry[];
	fence: boolean;
	configPath?: string;
	json: boolean;
	maxOutputTokens?: number;
	question?: string;
	apiKey?: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

export interface AnalyzeOutcome {
	/** Text printed to stdout (fenced or plain). */
	output: string;
	/** Whether the result came from cache. */
	cacheHit: boolean;
	/** Per-image records for --json. */
	records: Array<{ hash: string; description: string; error?: string }>;
}

async function readPayload(path: string): Promise<ImagePayload | { error: string }> {
	const r = await readImageFileWithReason(path);
	if (!r.image) {
		return {
			error: `could not read image: ${describeReadReason(r.reason ?? "not-an-image", r.bytes)}`,
		};
	}
	const img: ImageContent = r.image;
	const hash = hashImageData(img.data);
	storeImageMeta(hash, img.data, r.filename);
	const meta = metaForHash(hash);
	return { image: img, hash, meta, crop: undefined };
}

// metaForHash reads from the in-memory map populated by storeImageMeta.
function metaForHash(hash: string) {
	return _imageMeta.get(hash);
}

async function applyCrop(
	payload: ImagePayload,
	cropEntry: CropEntry,
): Promise<ImagePayload | { error: string }> {
	const meta = payload.meta;
	if (!meta) return { error: "cannot crop image - dimensions unknown" };
	try {
		const resolved = resolveCropEntry(cropEntry, meta.width, meta.height);
		const buf = Buffer.from(payload.image.data, "base64");
		const cropped = await cropImage(buf, resolved, payload.image.mimeType);
		if (!cropped) return { error: "crop failed" };
		const newImg: ImageContent = {
			type: "image",
			data: cropped.toString("base64"),
			mimeType: payload.image.mimeType,
		};
		const newHash = hashImageData(newImg.data);
		storeImageMeta(newHash, newImg.data, meta.filename);
		return { image: newImg, hash: newHash, meta: metaForHash(newHash), crop: resolved };
	} catch (err) {
		return { error: `crop failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function buildProviderOptions(
	format: GroundingFormat | undefined,
): Record<string, unknown> | undefined {
	// OpenAI imageDetail etc. would be attached here. Grounding format is
	// conveyed via the system prompt instead, so nothing extra by default.
	if (format && format !== "none") return undefined;
	return undefined;
}

/**
 * Run a vision analysis call, retrying across the configured fallback models
 * when a candidate fails at runtime (e.g. rate limit, server error). A missing
 * API key is reported up front by the caller, so here we only handle call
 * failures. Returns the first successful response.
 */
async function generateWithFallback(
	candidates: Array<{ provider: string; modelId: string; baseURL?: string }>,
	req: Omit<AnalyzeRequest, "model">,
	env: NodeJS.ProcessEnv,
	apiKey: string | undefined,
	configApiKey: string | undefined,
	analyzeImpl: typeof analyzeImagesWithModel,
): Promise<{ text: string; usedProvider: string; usedModel: string }> {
	let lastError: unknown;
	for (const c of candidates) {
		const resolved = resolveModel(c.provider, c.modelId, env, apiKey, c.baseURL, configApiKey);
		if (!resolved.ok) continue; // can't construct this candidate; try next
		try {
			const resp = await analyzeImpl({
				...req,
				model: resolved.model.model,
			});
			return { text: resp.text, usedProvider: c.provider, usedModel: c.modelId };
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError instanceof AnalyzeError
		? lastError
		: new AnalyzeError(
				lastError instanceof Error ? lastError.message : "all candidate models failed",
			);
}

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
	if (imagePaths.length > config.maxBatch) {
		throw new AnalyzeError(
			`too many images for batch (${imagePaths.length}). Maximum is ${config.maxBatch}.`,
		);
	}

	const provider = flags.provider ?? config.provider;
	const modelId = flags.model ?? config.modelId;

	if (!isKnownProvider(provider)) {
		throw new AnalyzeError(`unknown provider "${provider}"`);
	}

	// Build the ordered candidate list: primary model first, then configured
	// fallbacks. Each candidate carries a per-provider base URL override from
	// config.baseURLs (the *_BASE_URL env var still wins inside resolveModel).
	const candidates: Array<{ provider: string; modelId: string; baseURL?: string }> = [
		{ provider, modelId, baseURL: config.baseURLs[provider] },
	];
	for (const fm of config.fallbackModels) {
		const parsed = parseModelString(fm);
		if (parsed) {
			candidates.push({
				provider: parsed.provider,
				modelId: parsed.modelId,
				baseURL: config.baseURLs[parsed.provider],
			});
		}
	}

	// The primary model must be resolvable (have a key); fallbacks are only
	// tried on a runtime failure later, so a missing key on the primary is fatal.
	const modelOutcome = resolveModel(
		provider,
		modelId,
		env,
		flags.apiKey,
		config.baseURLs[provider],
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
		const read = await readPayload(imagePaths[i]!);
		if ("error" in read) throw new AnalyzeError(read.error);
		const cropForIndex = flags.crops?.find((c) => c.image_index === i);
		if (cropForIndex) {
			const cropped = await applyCrop(read, cropForIndex);
			if ("error" in cropped) throw new AnalyzeError(cropped.error);
			payloads.push(cropped);
		} else {
			payloads.push(read);
		}
	}

	const question = flags.question ?? "";

	// Cache-first single-image default path.
	if (!flags.joint && payloads.length === 1) {
		const p = payloads[0]!;
		const cropSig = p.crop ? cropSignature(p.crop) : undefined;
		const cacheKey = buildToolCacheKey(
			[p.hash],
			cropSig,
			hashImageData(question),
			`${provider}/${modelId}`,
		);
		const cached = await cacheGet(cacheKey);
		if (cached !== undefined) {
			const description = cached;
			const output = flags.fence
				? buildAnalyzeResult([p], description, effectiveFormat)
				: description;
			return {
				output,
				cacheHit: true,
				records: [{ hash: p.hash, description }],
			};
		}

		const resp = await generateWithFallback(
			candidates,
			{
				imagePayloads: [p],
				systemPrompt,
				question,
				maxOutputTokens: flags.maxOutputTokens,
			},
			env,
			flags.apiKey,
			config.apiKey,
			analyzeImpl,
		);
		const description = resp.text;
		await cacheSet(cacheKey, description);
		const output = flags.fence
			? buildAnalyzeResult([p], description, effectiveFormat)
			: description;
		return {
			output,
			cacheHit: false,
			records: [{ hash: p.hash, description }],
		};
	}

	// Joint multi-image path (explicit --joint, or multiple images).
	const allHashes = payloads.map((p) => p.hash);
	const cropSig = payloads.map((p) => (p.crop ? cropSignature(p.crop) : "full")).join("+");
	const jointCacheKey = buildToolCacheKey(
		allHashes,
		flags.joint ? `joint:${cropSig}` : cropSig,
		hashImageData(question),
		`${provider}/${modelId}`,
	);
	const cachedJoint = await cacheGet(jointCacheKey);
	if (cachedJoint !== undefined) {
		const description = cachedJoint;
		const output = flags.fence
			? buildJointDescriptionFence(
					payloads.map((p) => ({ hash: p.hash, meta: p.meta })),
					description,
					effectiveFormat,
				)
			: description;
		return {
			output,
			cacheHit: true,
			records: payloads.map((p) => ({ hash: p.hash, description })),
		};
	}

	const resp = await generateWithFallback(
		candidates,
		{
			imagePayloads: payloads,
			systemPrompt,
			question,
			providerOptions: buildProviderOptions(effectiveFormat),
			maxOutputTokens: flags.maxOutputTokens,
		},
		env,
		flags.apiKey,
		config.apiKey,
		analyzeImpl,
	);
	const description = resp.text;
	await cacheSet(jointCacheKey, description);
	const output = flags.fence
		? buildJointDescriptionFence(
				payloads.map((p) => ({ hash: p.hash, meta: p.meta })),
				description,
				effectiveFormat,
			)
		: description;
	return {
		output,
		cacheHit: false,
		records: payloads.map((p) => ({ hash: p.hash, description })),
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
