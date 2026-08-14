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
 * /vision-proxy max-tool-calls-per-turn <n> (-1 = unlimited)
 *
 * Environment (override everything):
 * PI_VISION_PROXY_MODE - "fallback" | "always" | "off"
 * PI_VISION_PROXY_MODEL - "provider/model-id"
 * PI_VISION_PROXY_INCLUDE_CONTEXT - "0"|"false" to disable, "1"|"true" to enable
 * PI_VISION_PROXY_TOOL - "on" | "off"
 * PI_VISION_PROXY_MAX_IMAGES_PER_CALL - 1..20
 * PI_VISION_PROXY_MAX_BATCH - 1..10
 * PI_VISION_PROXY_CACHE_SIZE - 0..500
 * PI_VISION_PROXY_MAX_TOOL_CALLS_PER_TURN - positive number to cap calls per turn; 0, -1, or "infinity" for unlimited (default: -1)
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
		description: "Image file paths",
		minItems: 1,
		maxItems: 20,
	}),
	question: Type.String({ description: "Question about the images" }),
	model: Type.Optional(Type.String({ description: "provider/model-id" })),
	crop: Type.Optional(Type.Array(CropEntrySchema, { description: "Crop entries" })),
	reason: Type.Optional(Type.String({ description: "Analytics reason" })),
});

const TOOL_DESCRIPTION = [
	"Use analyze_image when cached descriptions lack detail, for cross-image comparison, or to focus a region.",
	"Crop forms (preferred order): region (named), normalized (0-1 fractions), pixels (absolute).",
	"Pixel crops need prior width/height from vision_proxy_description / vision_proxy_analysis tags.",
	"When cropped, add crop_origin to returned coordinates to map back to the full image.",
	"Tool results are authoritative for the asked question; cached descriptions remain the default otherwise.",
].join(" ");

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
				promptSnippet: "Targeted image analysis with crop support",
				parameters: AnalyzeImageParams,
				execute: async (_toolCallId, params, _signal, _onUpdate, extCtx) => {
					const entries = extCtx.sessionManager.getEntries();
					const config = resolveConfig(entries, process.env, _fileConfig.value);

					const disabledError = toolDisabledError(config);
					if (disabledError) return disabledError;

					const rateLimitError = toolRateLimitError(config);
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
