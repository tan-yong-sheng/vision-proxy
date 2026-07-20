/** Extract a human-readable message from an unknown error. */
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type VisionModel } from "@earendil-works/pi-ai";
import {
	buildAnalysisFence,
	buildGroundingInstruction,
	buildJointDescriptionFence,
	CUSTOM_TYPE_COMMAND,
	CUSTOM_TYPE_DESCRIPTION,
	effectiveGroundingFormat,
	modelLabel,
	parseDescribeArgs,
	parseModelString,
	sanitizeForLog,
	type DescribeArgs,
	type GroundingFormat,
	type VisionConfig,
} from "../extensions/internal.js";
import {
	buildVisionPrompt,
	callVisionModel,
	extractTextFromResponse,
	resolveImagePayloads,
	type ImagePayload,
} from "./image-payloads.js";

type DescribeModelResult =
	| { ok: true; parsed: DescribeArgs; descConfig: VisionConfig; descVisionModel: VisionModel }
	| { ok: false; error: string };

/** Resolve the describe config, applying an optional --model override. */
function resolveDescribeConfig(
	effective: VisionConfig,
	parsed: DescribeArgs,
): VisionConfig | string {
	if (!parsed.model) return effective;
	const parsedModel = parseModelString(parsed.model);
	if (!parsedModel) return "Invalid model format. Use provider/model-id.";
	return { ...effective, ...parsedModel };
}

/** Resolve the requested model for a describe/redescribe command. */
async function resolveDescribeModel(
	sub: "describe" | "redescribe",
	value: string,
	effective: VisionConfig,
	ctx: ExtensionContext,
): Promise<DescribeModelResult> {
	const parsed = parseDescribeArgs(value, sub === "redescribe");
	if (typeof parsed === "string") return { ok: false, error: parsed };
	const descConfig = resolveDescribeConfig(effective, parsed);
	if (typeof descConfig === "string") return { ok: false, error: descConfig };
	const descVisionModel = ctx.modelRegistry.find(descConfig.provider, descConfig.modelId);
	if (!descVisionModel) {
		return {
			ok: false,
			error: `Model "${modelLabel(descConfig)}" not found. Use /vision-proxy pick to choose one.`,
		};
	}
	return { ok: true, parsed, descConfig, descVisionModel };
}

type DescribePayloadResult =
	| { ok: true; imagePayloads: ImagePayload[]; anyCropApplied: boolean }
	| { ok: false; error: string };

type DescribePipelineResult =
	| {
			ok: true;
			parsed: DescribeArgs;
			descConfig: VisionConfig;
			imagePayloads: ImagePayload[];
			callResult: Extract<DescribeCallResult, { ok: true }>;
	  }
	| { ok: false; error: string; severity: "warning" | "error" };

/** Resolve image payloads and crops for a describe command. */
async function resolveDescribePayloads(
	parsed: DescribeArgs,
	descConfig: VisionConfig,
	ctx: ExtensionContext,
): Promise<DescribePayloadResult> {
	const result = await resolveImagePayloads(
		parsed.images,
		parsed.crops,
		descConfig.maxImagesPerCall,
		ctx,
	);
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true, imagePayloads: result.payloads, anyCropApplied: result.anyCropApplied };
}

type DescribeAuthResult = { apiKey: string; headers?: Record<string, string> } | string;

/** Fetch API auth for a describe model, returning an error string on failure. */
async function fetchDescribeAuth(
	descVisionModel: VisionModel,
	descConfig: VisionConfig,
	ctx: ExtensionContext,
): Promise<DescribeAuthResult> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(descVisionModel);
	if (!auth.ok || !auth.apiKey) {
		return `No API key for ${descVisionModel.name ?? modelLabel(descConfig)}. Run: pi --login ${descConfig.provider}`;
	}
	return { apiKey: auth.apiKey, headers: auth.headers };
}

type DescribeCallResult =
	| { ok: true; text: string; latencyMs: number }
	| { ok: false; error: string; aborted?: boolean };

/** Execute the vision-model completion and return the text or an error. */
async function executeDescribeComplete(
	descVisionModel: VisionModel,
	descConfig: VisionConfig,
	imagePayloads: ImagePayload[],
	question: string,
	apiKey: string,
	headers: Record<string, string> | undefined,
	ctx: ExtensionContext,
): Promise<DescribeCallResult> {
	try {
		const startTime = Date.now();
		const response = await callVisionModel(
			descVisionModel,
			descConfig.systemPrompt + buildGroundingInstruction(effectiveGroundingFormat(descConfig)),
			buildVisionPrompt(imagePayloads, question),
			{ apiKey, headers, signal: ctx.signal },
		);
		if (response.stopReason === "aborted") {
			return { ok: false, error: "Cancelled.", aborted: true };
		}
		const text = extractTextFromResponse(response);
		if (!text) return { ok: false, error: "Vision model returned an empty response." };
		return { ok: true, text, latencyMs: Date.now() - startTime };
	} catch (err) {
		return { ok: false, error: errorMessage(err) };
	}
}

/** Return the question to use for a describe/redescribe call. */
function describeQuestion(parsed: DescribeArgs): string {
	return parsed.question ? parsed.question : "Describe the image in detail.";
}

/** Call the vision model and return either the extracted text or an error. */
async function runDescribeCall(
	descVisionModel: VisionModel,
	descConfig: VisionConfig,
	imagePayloads: ImagePayload[],
	parsed: DescribeArgs,
	ctx: ExtensionContext,
): Promise<DescribeCallResult> {
	const authResult = await fetchDescribeAuth(descVisionModel, descConfig, ctx);
	if (typeof authResult === "string") return { ok: false, error: authResult };
	return executeDescribeComplete(
		descVisionModel,
		descConfig,
		imagePayloads,
		describeQuestion(parsed),
		authResult.apiKey,
		authResult.headers,
		ctx,
	);
}

/** Build a single-image or joint description fence. */
function buildDescribeFence(
	imagePayloads: ImagePayload[],
	text: string,
	groundingFormat: GroundingFormat | undefined,
): string {
	if (imagePayloads.length === 1) {
		return buildAnalysisFence(
			imagePayloads[0]!.hash,
			text,
			imagePayloads[0]!.meta,
			imagePayloads[0]!.crop,
			groundingFormat,
		);
	}
	return buildJointDescriptionFence(
		imagePayloads.map((p) => ({ hash: p.hash, meta: p.meta })),
		text,
		groundingFormat,
	);
}

/** Persist a canonical description when --save or redescribe is used. */
function maybeSaveDescription(
	parsed: DescribeArgs,
	imagePayloads: ImagePayload[],
	text: string,
): void {
	if (parsed.save && imagePayloads.length === 1) {
		pi.appendEntry(CUSTOM_TYPE_DESCRIPTION, {
			hash: imagePayloads[0]!.hash,
			description: text,
		});
	}
}

/** Log describe/redescribe telemetry. */
function logDescribeTelemetry(
	sub: "describe" | "redescribe",
	imagePayloads: ImagePayload[],
	parsed: DescribeArgs,
	descConfig: VisionConfig,
	latencyMs: number,
): void {
	pi.appendEntry(CUSTOM_TYPE_COMMAND, {
		command: sub,
		images: imagePayloads.map((p) => p.hash),
		question: sanitizeForLog(parsed.question ?? "Describe the image in detail."),
		save: parsed.save,
		model: `${descConfig.provider}/${descConfig.modelId}`,
		latencyMs,
	});
}

/** Emit the final fence, telemetry, and UI notification for a describe result. */
function emitDescribeResult(
	sub: "describe" | "redescribe",
	ctx: ExtensionContext,
	parsed: DescribeArgs,
	descConfig: VisionConfig,
	imagePayloads: ImagePayload[],
	callResult: Extract<DescribeCallResult, { ok: true }>,
): void {
	const fence = buildDescribeFence(
		imagePayloads,
		callResult.text,
		effectiveGroundingFormat(descConfig),
	);
	maybeSaveDescription(parsed, imagePayloads, callResult.text);
	logDescribeTelemetry(sub, imagePayloads, parsed, descConfig, callResult.latencyMs);
	ctx.ui.notify(`\n[Vision Proxy] ${fence}`, "info");
}

/** Report a describe/redescribe failure and return whether the caller should stop. */
function notifyDescribeFailure(
	ctx: ExtensionContext,
	callResult: DescribeCallResult,
): boolean {
	if (!callResult.ok) {
		const message = callResult.aborted
			? "[Vision Proxy] Cancelled."
			: `[Vision Proxy] ${callResult.error}`;
		ctx.ui.notify(message, callResult.aborted ? "info" : "error");
		return true;
	}
	return false;
}

/** Run model, payload, and vision-model resolution for a describe command. */
async function runDescribePipeline(
	sub: "describe" | "redescribe",
	value: string,
	effective: VisionConfig,
	ctx: ExtensionContext,
): Promise<DescribePipelineResult> {
	const modelResult = await resolveDescribeModel(sub, value, effective, ctx);
	if (!modelResult.ok) return { ok: false, error: modelResult.error, severity: "warning" };
	const payloadResult = await resolveDescribePayloads(
		modelResult.parsed,
		modelResult.descConfig,
		ctx,
	);
	if (!payloadResult.ok) return { ok: false, error: payloadResult.error, severity: "error" };
	const callResult = await runDescribeCall(
		modelResult.descVisionModel,
		modelResult.descConfig,
		payloadResult.imagePayloads,
		modelResult.parsed,
		ctx,
	);
	if (!callResult.ok) return { ok: false, error: callResult.error, severity: "error" };
	return {
		ok: true,
		parsed: modelResult.parsed,
		descConfig: modelResult.descConfig,
		imagePayloads: payloadResult.imagePayloads,
		callResult,
	};
}

/** Notify the user when the proxy is off; returns true if it was off. */
function guardProxyOff(ctx: ExtensionContext, effective: VisionConfig): boolean {
	if (effective.mode === "off") {
		ctx.ui.notify(
			"[vision-proxy] Proxy is off - enable with /vision-proxy fallback or /vision-proxy always.",
			"warning",
		);
		return true;
	}
	return false;
}

/** Handle /vision-proxy describe and /vision-proxy redescribe. */
export async function handleDescribeCommand(
	sub: "describe" | "redescribe",
	value: string,
	ctx: ExtensionContext,
	effective: VisionConfig,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	pi: ExtensionAPI,
): Promise<void> {
	if (guardProxyOff(ctx, effective)) return;

	const pipeline = await runDescribePipeline(sub, value, effective, ctx);
	if (!pipeline.ok) {
		ctx.ui.notify(`[vision-proxy] ${pipeline.error}`, pipeline.severity);
		return;
	}
	if (notifyDescribeFailure(ctx, pipeline.callResult)) return;

	emitDescribeResult(
		sub,
		ctx,
		pipeline.parsed,
		pipeline.descConfig,
		pipeline.imagePayloads,
		pipeline.callResult,
	);
};
