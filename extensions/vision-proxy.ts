/**
 * Vision Proxy - automatic image description for any model in Pi
 *
 * Modes:
 * "fallback" - only activates when the active model lacks image support (default)
 * "always" - always uses the proxy, even if the active model supports images
 * "off" - disabled entirely
 *
 * Configuration:
 * Interactive: /vision-proxy - shows current config & lets you change it
 * /vision-proxy fallback|always|off
 * /vision-proxy pick - pick from vision-capable models (friendly names)
 * /vision-proxy model provider/model-id
 * /vision-proxy context on|off - include conversation context in proxy prompt
 * /vision-proxy tool on|off - enable/disable analyze_image tool
 * /vision-proxy max-images-per-call <n>
 * /vision-proxy max-batch <n>
 * /vision-proxy cache-size <n>
 *
 * Environment (override everything):
 * PI_VISION_PROXY_MODE - "fallback" | "always" | "off"
 * PI_VISION_PROXY_MODEL - "provider/model-id"
 * PI_VISION_PROXY_INCLUDE_CONTEXT - "0"|"false" to disable, "1"|"true" to enable
 * PI_VISION_PROXY_TOOL - "on" | "off"
 * PI_VISION_PROXY_MAX_IMAGES_PER_CALL - 1..20
 * PI_VISION_PROXY_MAX_BATCH - 1..10
 * PI_VISION_PROXY_CACHE_SIZE - 0..500
 *
 * Install:
 * pi install ./packages/pi-vision-proxy
 */
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { handleBeforeAgentStart } from "./helpers/before-agent.js";
import { Type } from "typebox";
import {
	CUSTOM_TYPE_CONFIG,
	findDescriptions,
	_imageMeta,
	readPersistentFile,
	resolveConfig,
	sanitize,
	writePersistentFile,
	type VisionConfig,
} from "./internal.js";
import { commandHandler } from "../lib/commands.js";
import { handleDescribeCommand } from "../lib/describe.js";
import {
	toolDisabledError,
	toolRateLimitError,
	transformMessages,
} from "../lib/messages.js";
import {
	_toolCache,
	_toolCallCount,
	_toolRegistered,
	_fileConfig,
	friendlyModelLabel,
	shouldStripImages,
} from "../lib/shared.js";
import { analyzeImages, handleAnalyzeImage } from "../lib/analyze.js";


// ── Tool schema (TypeBox) ──────────────────────────────────────────────────
const NamedRegionSchema = Type.Union(
	[
		Type.Literal("top-left"),
		Type.Literal("top-right"),
		Type.Literal("bottom-left"),
		Type.Literal("bottom-right"),
		Type.Literal("top"),
		Type.Literal("bottom"),
		Type.Literal("left"),
		Type.Literal("right"),
		Type.Literal("center"),
		Type.Literal("top-half"),
		Type.Literal("bottom-half"),
		Type.Literal("left-half"),
		Type.Literal("right-half"),
	],
	{ description: "Coarse named region" },
);

const CropEntrySchema = Type.Union([
	Type.Object(
		{
			image_index: Type.Integer({
				minimum: 0,
				description: "0-based index into the images array",
			}),
			region: NamedRegionSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			image_index: Type.Integer({
				minimum: 0,
				description: "0-based index into the images array",
			}),
			normalized: Type.Object({
				x: Type.Number(),
				y: Type.Number(),
				width: Type.Number(),
				height: Type.Number(),
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			image_index: Type.Integer({
				minimum: 0,
				description: "0-based index into the images array",
			}),
			pixels: Type.Object({
				x: Type.Number(),
				y: Type.Number(),
				width: Type.Number(),
				height: Type.Number(),
			}),
		},
		{ additionalProperties: false },
	),
]);

const AnalyzeImageParams = Type.Object({
	images: Type.Array(Type.String(), {
		description:
			"1..maxImagesPerCall image file paths (sha256 references are not supported)",
		minItems: 1,
		maxItems: 20,
	}),
	question: Type.String({ description: "Required, non-empty, max 4000 chars" }),
	model: Type.Optional(
		Type.String({ description: "Optional; provider/model-id" }),
	),
	crop: Type.Optional(
		Type.Array(CropEntrySchema, { description: "Optional per-image crop" }),
	),
	reason: Type.Optional(
		Type.String({ description: "Optional; logged for analytics only" }),
	),
});

const TOOL_DESCRIPTION = [
	"Use `analyze_image` when (a) the cached description of an image lacks a detail you need,",
	"(b) you need to compare or cross-reference multiple images, or (c) you need to focus on a specific region.",
	"",
	"**Cropping.** Three forms, in order of preference:",
	"",
	'- **`region`** - coarse cut by name. Use when you don\'t have exact dimensions: `{ image_index: 0, region: "bottom-right" }`.',
	"- **`normalized`** - fractional coordinates 0.0-1.0. Default choice for precise crops without knowing image dimensions: `{ image_index: 0, normalized: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 } }`.",
	"- **`pixels`** - absolute pixels. Use only when you have authoritative coordinates from a prior `<vision_proxy_description>` or `<vision_proxy_analysis>` (which carry `width` and `height` attributes) or from a previous grounded response. Example: `{ image_index: 0, pixels: { x: 1840, y: 120, width: 840, height: 360 } }`.",
	"",
	"Image dimensions and filenames are available in the `width`, `height`, and `filename` attributes of `<vision_proxy_description>`, `<vision_proxy_analysis>`, and `<vision_proxy_joint_description>` blocks in your context.",
	"",
	"When a crop is applied, the response fence carries a `crop_origin` attribute (e.g. `crop_origin=\"1840,120\"`). Add the origin's x to any returned x-coordinate and the origin's y to any returned y-coordinate to map coordinates back to the original full image.",
	"",
	"The tool result is authoritative for the specific question asked; the cached generic description remains the default for everything else.",
].join("\n");

// ── Extension ──────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	/** Register or unregister the analyze_image tool based on config. */
	function syncToolRegistration(config: VisionConfig) {
		const shouldHaveTool = config.mode !== "off" && config.tool === "on";
		if (shouldHaveTool && !_toolRegistered.value) {
			pi.registerTool({
				name: "analyze_image",
				label: "Analyze Image",
				description: TOOL_DESCRIPTION,
				promptSnippet:
					"Targeted image analysis with crop and grounding support",
				promptGuidelines: [
					"Use analyze_image when you need specific details about an image that the cached description doesn't cover.",
					"The tool supports cropping - use region, normalized, or pixel coordinates to focus on a specific area.",
					"Results include image dimensions, filename, and grounding format metadata in the response fence.",
				],
				parameters: AnalyzeImageParams,
				execute: async (_toolCallId, params, _signal, _onUpdate, extCtx) => {
					const entries = extCtx.sessionManager.getEntries();
					const config = resolveConfig(entries, process.env, _fileConfig.value);

					const disabledError = toolDisabledError(config);
					if (disabledError) return disabledError;

					const rateLimitError = toolRateLimitError();
					if (rateLimitError) return rateLimitError;

					// Sync cache size with current config
					if (_toolCache.maxSize !== config.cacheSize) {
						_toolCache.resize(config.cacheSize);
					}

					const result = await handleAnalyzeImage(params, extCtx, pi, config);
					return { content: [{ type: "text" as const, text: result }] };
				},
			});
			_toolRegistered.value = true;
		}
		// Note: Pi's extension API doesn't have unregisterTool - tool registration
		// persists for the session. The tool's execute handler checks the current
		// config at runtime and returns an error if disabled.
	}

	pi.on(
		"session_start",
		async (_event: SessionStartEvent, ctx: ExtensionContext) => {
			// Clear per-session state from previous sessions
			_imageMeta.clear();
			_toolCache.clear();

			_fileConfig.value = await readPersistentFile();
			const config = resolveConfig(
				ctx.sessionManager.getEntries(),
				process.env,
				_fileConfig.value,
			);

			ctx.ui.setStatus(
				"vision-proxy",
				`vision-proxy: ${config.mode} → ${friendlyModelLabel(config, ctx.modelRegistry)}${config.tool === "on" && config.mode !== "off" ? " [+tool]" : ""}`,
			);

			// Register tool if enabled
			syncToolRegistration(config);
		},
	);

	pi.on(
		"before_agent_start",
		async (
			event: BeforeAgentStartEvent,
			ctx: ExtensionContext,
		): Promise<BeforeAgentStartEventResult | void> => {
			_toolCallCount.value = 0;
			return handleBeforeAgentStart(event, ctx, pi, analyzeImages, _fileConfig.value);
		},
	);

	pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
		const entries = ctx.sessionManager.getEntries();
		const config = resolveConfig(entries, process.env, _fileConfig.value);
		if (!shouldStripImages(config, ctx.model)) return;

		const descriptions = findDescriptions(entries);
		const transformed = transformMessages(event.messages, descriptions);
		event.messages.splice(0, event.messages.length, ...transformed.messages);
	});

	pi.registerCommand("vision-proxy", {
		description:
			"Configure the vision proxy (images — mode, model, context, tool)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const sync = await commandHandler(args, ctx, pi, _fileConfig.value);
			if (sync) {
				syncToolRegistration(
					resolveConfig(
						ctx.sessionManager.getEntries(),
						process.env,
						_fileConfig.value,
					),
				);
			}
		},
	});
}
