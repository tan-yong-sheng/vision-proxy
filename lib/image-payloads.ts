import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	complete,
	type ImageContent as PiAiImage,
} from "@earendil-works/pi-ai";
import {
	bufferToPiAiImage,
	cropImage,
	describeReadReason,
	hashImageData,
	piAiImageToBuffer,
	readImageFileWithReason,
	resolveCropEntry,
	storeImageMeta,
	type CropEntry,
	type ImageMeta,
	_imageMeta,
} from "../extensions/internal.js";
import { sanitizeXml } from "./shared.js";

// ── Helpers ────────────────────────────────────────────────────────────────

export type ImagePayload = {
	image: PiAiImage;
	hash: string;
	meta: ImageMeta | undefined;
	crop?: ReturnType<typeof resolveCropEntry>;
};

/** Validate the number of image references against the configured maximum. */
export function validateImageCount(imageRefs: string[], maxImages: number): string | null {
	if (imageRefs.length === 0) return "at least one image is required";
	if (imageRefs.length > maxImages) {
		return `too many images (${imageRefs.length}). Maximum is ${maxImages}.`;
	}
	return null;
}

/** Validate a single crop index is within range. */
export function isCropOutOfRange(index: number, imageCount: number): boolean {
	if (index < 0) return true;
	if (index >= imageCount) return true;
	return false;
}

/** Validate crop indices are within range. */
export function validateCropRanges(
	crops: CropEntry[],
	imageCount: number,
): string | null {
	for (const c of crops) {
		if (isCropOutOfRange(c.image_index, imageCount)) {
			return `crop image_index ${c.image_index} is out of range (0-${imageCount - 1}).`;
		}
	}
	return null;
}

/** Validate crop indices have no duplicates. */
export function validateCropDuplicates(crops: CropEntry[]): string | null {
	const seen = new Set<number>();
	for (const c of crops) {
		if (seen.has(c.image_index)) {
			return `duplicate crop for image index ${c.image_index}. At most one crop per image.`;
		}
		seen.add(c.image_index);
	}
	return null;
}

/** Validate crop indices: no duplicates and all in range. */
export function validateCropIndices(
	crops: CropEntry[] | undefined,
	imageCount: number,
): string | null {
	if (!crops) return null;
	if (crops.length === 0) return null;
	const duplicateError = validateCropDuplicates(crops);
	if (duplicateError) return duplicateError;
	return validateCropRanges(crops, imageCount);
}

/** Validate a single image reference is a usable path. */
export function validateImageRef(ref: string): string | null {
	if (ref.startsWith("sha256:")) {
		return "sha256 references are not supported. Provide a file path for the image.";
	}
	if (ref.includes("..")) return 'path contains disallowed ".." segments.';
	return null;
}

/** Resolve every image reference into a decoded image entry. */
export async function resolveImageRefs(
	imageRefs: string[],
): Promise<{ ok: true; entries: ImagePayload[] } | { ok: false; error: string }> {
	const entries: ImagePayload[] = [];
	for (const ref of imageRefs) {
		const refError = validateImageRef(ref);
		if (refError) return { ok: false, error: refError };
		const result = await readAndStoreImage(ref);
		if (!result.ok) return { ok: false, error: result.error };
		entries.push(result.entry);
	}
	return { ok: true, entries };
}

/** Find the crop entry for a given image index, if any. */
export function findCropForIndex(
	crops: CropEntry[] | undefined,
	index: number,
): CropEntry | undefined {
	if (!crops) return undefined;
	return crops.find((c) => c.image_index === index);
}

/** Resolve a crop entry against image dimensions and return the cropped payload. */
export function resolveCropForPayload(
	entry: ImagePayload,
	cropEntry: CropEntry,
	index: number,
): { ok: true; payload: ImagePayload } | { ok: false; error: string } {
	const meta = entry.meta;
	if (!meta) {
		return {
			ok: false,
			error: `cannot crop image ${index} - image dimensions unknown.`,
		};
	}
	try {
		const resolved = resolveCropEntry(cropEntry, meta.width, meta.height);
		return { ok: true, payload: { ...entry, crop: resolved } };
	} catch (err) {
		return {
			ok: false,
			error: `crop for image ${index} failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/** Build payloads from resolved images, applying any requested crops. */
export function buildCroppedPayloads(
	entries: ImagePayload[],
	crops: CropEntry[] | undefined,
): { ok: true; payloads: ImagePayload[] } | { ok: false; error: string } {
	const payloads: ImagePayload[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const cropEntry = findCropForIndex(crops, i);
		if (!cropEntry) {
			payloads.push(entry);
			continue;
		}
		const resolved = resolveCropForPayload(entry, cropEntry, i);
		if (!resolved.ok) return { ok: false, error: resolved.error };
		payloads.push(resolved.payload);
	}
	return { ok: true, payloads };
}

/** Validate the initial image-count and crop-index constraints. */
export function validateImageSetup(
	imageRefs: string[],
	maxImages: number,
	crops: CropEntry[] | undefined,
): string | null {
	const countError = validateImageCount(imageRefs, maxImages);
	if (countError) return countError;
	return validateCropIndices(crops, imageRefs.length);
}

export async function resolveImagePayloads(
	imageRefs: string[],
	crops: CropEntry[] | undefined,
	maxImages: number,
	ctx: ExtensionContext,
): Promise<
	| { ok: true; payloads: ImagePayload[]; anyCropApplied: boolean }
	| { ok: false; error: string }
> {
	const setupError = validateImageSetup(imageRefs, maxImages, crops);
	if (setupError) return { ok: false, error: setupError };

	const resolved = await resolveImageRefs(imageRefs);
	if (!resolved.ok) return { ok: false, error: resolved.error };

	const built = buildCroppedPayloads(resolved.entries, crops);
	if (!built.ok) return { ok: false, error: built.error };

	const anyCropApplied = await applyCropsToPayloads(
		built.payloads,
		(msg) => ctx.ui.notify(`[vision-proxy] ${msg}`, "warning"),
	);

	return { ok: true, payloads: built.payloads, anyCropApplied };
}

/** Extract plain text from a PiAi completion response. */
export function extractTextFromResponse(
	response: {
		content: Array<{ type: string; text?: string }>;
	},
): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/** Read an image file, store its metadata, and return the resolved entry or an error message. */
export async function readAndStoreImage(
	ref: string,
): Promise<
	| { ok: true; entry: { image: PiAiImage; hash: string; meta: ImageMeta | undefined } }
	| { ok: false; error: string }
> {
	const r = await readImageFileWithReason(ref);
	if (!r.image) {
		return {
			ok: false,
			error: `could not read image: ${describeReadReason(r.reason ?? "not-an-image", r.bytes)}`,
		};
	}
	const hash = hashImageData(r.image.data);
	storeImageMeta(hash, r.image.data, r.filename);
	return { ok: true, entry: { image: r.image, hash, meta: _imageMeta.get(hash) } };
}

/** Apply crop regions to image bytes in-place. Returns whether any crop succeeded. */
export async function applyCropsToPayloads(
	imagePayloads: Array<{
		image: PiAiImage;
		crop?: ReturnType<typeof resolveCropEntry>;
	}>,
	onWarn: (msg: string) => void,
): Promise<boolean> {
	let anyApplied = false;
	for (const p of imagePayloads) {
		if (p.crop) {
			const buf = piAiImageToBuffer(p.image);
			const cropped = await cropImage(buf, p.crop, p.image.mimeType);
			if (cropped) {
				p.image = bufferToPiAiImage(cropped, p.image.mimeType);
				anyApplied = true;
			} else {
				onWarn("Crop failed for an image — sending full image instead.");
				p.crop = undefined;
			}
		}
	}
	return anyApplied;
}

/** Build the width x height string for an image payload. */
export function imageDimension(
	crop: { width: number; height: number } | undefined,
	meta: ImageMeta | undefined,
): string {
	if (crop) return `${crop.width}x${crop.height}`;
	if (meta) return `${meta.width}x${meta.height}`;
	return "?x?";
}

/** Build the optional filename suffix for an image label. */
export function imageFilenameSuffix(meta: ImageMeta | undefined): string {
	if (meta && meta.filename) return ` (${meta.filename})`;
	return "";
}

/** Build a single image label for the vision prompt. */
export function formatImageLabel(
	p: {
		image: PiAiImage;
		meta?: ImageMeta;
		crop?: { width: number; height: number };
	},
	i: number,
): string {
	return `Image ${i + 1}: ${imageDimension(p.crop, p.meta)} pixels${imageFilenameSuffix(p.meta)}`;
}

/** Build the user prompt content parts for a vision request. */
export function buildVisionPrompt(
	imagePayloads: Array<{
		image: PiAiImage;
		meta?: ImageMeta;
		crop?: { width: number; height: number };
	}>,
	question: string,
): Array<{ type: "text"; text: string } | PiAiImage> {
	const imageLabels = imagePayloads.map(formatImageLabel).join("\n");

	const contentParts: Array<{ type: "text"; text: string } | PiAiImage> = [];
	contentParts.push({
		type: "text",
		text:
			(imagePayloads.length > 1
				? `You are analysing ${imagePayloads.length} images.\n${imageLabels}\n\n`
				: "") +
			`Answer the following question about the image${imagePayloads.length > 1 ? "s" : ""}:\n` +
			`<question>\n${sanitizeXml(question)}\n</question>\n\n` +
			`Respond in the same language as the question. Be precise and factual.`,
	});
	for (const p of imagePayloads) contentParts.push(p.image);
	return contentParts;
}

/** Call the vision model with a standardized message shape. */
export async function callVisionModel(
	model: Parameters<typeof complete>[0],
	systemPrompt: string,
	contentParts: Array<{ type: "text"; text: string } | PiAiImage>,
	api: { apiKey: string; headers?: Record<string, string>; signal: AbortSignal },
): Promise<Awaited<ReturnType<typeof complete>>> {
	return complete(
		model,
		{
			systemPrompt,
			messages: [{ role: "user", content: contentParts, timestamp: Date.now() }],
		},
		api,
	);
}