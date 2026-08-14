import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	envFlags,
	isGroundingExcluded,
	modeLabel,
	modelLabel,
	parseGroundingFormat,
	parseModelString,
	sanitize,
	splitSubcommand,
	VALID_GROUNDING_FORMATS,
	type EnvFlags,
	type GroundingFormat,
	type ProxyMode,
	CUSTOM_TYPE_CONFIG,
	persistedBase,
	resolveConfig,
	writePersistentFile,
	type VisionConfig,
} from "../extensions/internal.js";
import { handleDescribeCommand } from "./describe.js";
import { _toolRegistered, friendlyModelLabel, pickVisionModel } from "./shared.js";

const TOGGLE_MAP: Record<string, boolean> = {
	yes: true,
	true: true,
	"1": true,
	on: true,
	no: false,
	false: false,
	"0": false,
	off: false,
};

type NumericConfigKey = "maxImagesPerCall" | "maxBatch" | "cacheSize" | "maxToolCallsPerTurn";

/** Context passed to command dispatch handlers. */
interface CommandDispatchContext {
	sub: string;
	value: string;
	valueLower: string;
	ctx: ExtensionContext;
	persisted: VisionConfig;
	effective: VisionConfig;
	env: EnvFlags;
	writePersisted: (next: VisionConfig) => VisionConfig;
}

/** Map of /vision-proxy subcommands to their handlers. */
const COMMAND_DISPATCH: Record<
	string,
	(c: CommandDispatchContext) => Promise<boolean>
> = {
	fallback: async (c) =>
		handleModeCommand("fallback", c.ctx, c.persisted, c.writePersisted, c.env),
	always: async (c) =>
		handleModeCommand("always", c.ctx, c.persisted, c.writePersisted, c.env),
	off: async (c) =>
		handleModeCommand("off", c.ctx, c.persisted, c.writePersisted, c.env),
	pick: async (c) => {
		await pickVisionModel(c.ctx, c.persisted, c.writePersisted, !!c.env.model);
		return false;
	},
	model: async (c) => {
		await handleModelCommand(
			c.value,
			c.ctx,
			c.persisted,
			c.writePersisted,
			!!c.env.model,
		);
		return false;
	},
	context: async (c) => {
		await handleContextCommand(
			c.valueLower,
			c.ctx,
			c.persisted,
			c.writePersisted,
			c.effective.includeContext,
			!!c.env.context,
		);
		return false;
	},
	tool: async (c) =>
		handleToolCommand(
			c.valueLower,
			c.ctx,
			c.persisted,
			c.writePersisted,
			!!c.env.tool,
			c.effective,
		),
	"max-images-per-call": async (c) => {
		await handleNumericCommand(
			"max-images-per-call",
			c.value,
			c.ctx,
			c.persisted,
			c.writePersisted,
			"maxImagesPerCall",
			"Max images per call",
			1,
			20,
			"PI_VISION_PROXY_MAX_IMAGES_PER_CALL",
			!!c.env.maxImagesPerCall,
		);
		return false;
	},
	"max-batch": async (c) => {
		await handleNumericCommand(
			"max-batch",
			c.value,
			c.ctx,
			c.persisted,
			c.writePersisted,
			"maxBatch",
			"Max batch",
			1,
			10,
			"PI_VISION_PROXY_MAX_BATCH",
			!!c.env.maxBatch,
		);
		return false;
	},
	"cache-size": async (c) => {
		await handleNumericCommand(
			"cache-size",
			c.value,
			c.ctx,
			c.persisted,
			c.writePersisted,
			"cacheSize",
			"Cache size",
			0,
			500,
			"PI_VISION_PROXY_CACHE_SIZE",
			!!c.env.cacheSize,
		);
		return false;
	},
	"max-tool-calls-per-turn": async (c) => {
		await handleNumericCommand(
			"max-tool-calls-per-turn",
			c.value,
			c.ctx,
			c.persisted,
			c.writePersisted,
			"maxToolCallsPerTurn",
			"Max tool calls per turn",
			-1,
			100,
			"PI_VISION_PROXY_MAX_TOOL_CALLS_PER_TURN",
			!!c.env.maxToolCallsPerTurn,
		);
		return false;
	},
	"grounding-models": async (c) => {
		await handleGroundingModelsCommand(
			c.value,
			c.ctx,
			c.persisted,
			c.effective,
			c.writePersisted,
		);
		return false;
	},
	describe: async (c) => {
		await handleDescribeCommand(
			"describe",
			c.value,
			c.ctx,
			c.effective,
			c.persisted,
			c.writePersisted,
		);
		return false;
	},
	redescribe: async (c) => {
		await handleDescribeCommand(
			"redescribe",
			c.value,
			c.ctx,
			c.effective,
			c.persisted,
			c.writePersisted,
		);
		return false;
	},
};

async function handleModeCommand(
	sub: string,
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	env: EnvFlags,
): Promise<boolean> {
	if (env.mode) {
		ctx.ui.notify(
			"[vision-proxy] PI_VISION_PROXY_MODE is set - env overrides commands. Unset to change.",
			"warning",
		);
		return false;
	}
	if (!["fallback", "always", "off"].includes(sub)) {
		ctx.ui.notify("Usage: /vision-proxy fallback|always|off", "warning");
		return false;
	}
	const next = writePersisted({ ...persisted, mode: sub as ProxyMode });
	ctx.ui.notify(
		`Vision proxy: ${modeLabel(next.mode)}`,
		next.mode === "off" ? "warning" : "info",
	);
	return true;
}

async function handleModelCommand(
	value: string,
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	envModel: boolean,
): Promise<void> {
	if (envModel) {
		ctx.ui.notify(
			"[vision-proxy] PI_VISION_PROXY_MODEL is set - env overrides commands. Unset to change.",
			"warning",
		);
		return;
	}
	const parsed = parseModelString(value);
	if (!parsed) {
		ctx.ui.notify(
			"Usage: /vision-proxy model provider/model-id\nExample: /vision-proxy model anthropic/claude-sonnet-4-5",
			"warning",
		);
		return;
	}
	const next = writePersisted({ ...persisted, ...parsed });
	ctx.ui.notify(`Vision proxy model: ${modelLabel(next)}`, "info");
}

async function handleContextCommand(
	valueLower: string,
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	currentValue: boolean,
	envContext: boolean,
): Promise<void> {
	if (envContext) {
		ctx.ui.notify(
			"[vision-proxy] PI_VISION_PROXY_INCLUDE_CONTEXT is set - env overrides commands. Unset to change.",
			"warning",
		);
		return;
	}
	const nextValue = TOGGLE_MAP[valueLower];
	if (nextValue === undefined) {
		ctx.ui.notify(
			`[vision-proxy] Conversation context: ${toggleLabel(currentValue)}. Use /vision-proxy context on|off.`,
			"info",
		);
		return;
	}
	writePersisted({ ...persisted, includeContext: nextValue });
	ctx.ui.notify(
		`[vision-proxy] Conversation context: ${toggleLabel(nextValue)}`,
		nextValue ? "info" : "warning",
	);
}

async function handleToolCommand(
	valueLower: string,
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	envTool: boolean,
	effective: VisionConfig,
): Promise<boolean> {
	if (envTool) {
		ctx.ui.notify(
			"[vision-proxy] PI_VISION_PROXY_TOOL is set - env overrides commands. Unset to change.",
			"warning",
		);
		return false;
	}
	if (valueLower === "on") {
		writePersisted({ ...persisted, tool: "on" });
		ctx.ui.notify(`[vision-proxy] analyze_image tool: ON`, "info");
		return true;
	}
	if (valueLower === "off") {
		writePersisted({ ...persisted, tool: "off" });
		ctx.ui.notify(
			`[vision-proxy] analyze_image tool: OFF (existing calls will return disabled error)`,
			"warning",
		);
		return false;
	}
	ctx.ui.notify(
		`[vision-proxy] Tool: ${effective.tool}. Use /vision-proxy tool on|off.`,
		"info",
	);
	return false;
}

async function handleNumericCommand(
	sub: string,
	value: string,
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	envKey: NumericConfigKey,
	label: string,
	min: number,
	max: number,
	envName: string,
	envValue: boolean,
): Promise<void> {
	if (envValue) {
		ctx.ui.notify(
			`[vision-proxy] ${envName} is set - env overrides commands.`,
			"warning",
		);
		return;
	}
	const n = Number.parseInt(value, 10);
	if (isInvalidInt(n, min, max)) {
		ctx.ui.notify(`Usage: /vision-proxy ${sub} <${min}-${max}>`, "warning");
		return;
	}
	writePersisted({ ...persisted, [envKey]: n });
	ctx.ui.notify(`[vision-proxy] ${label}: ${n}`, "info");
}

function formatEnvOverrides(env: EnvFlags): string {
	const keys: (keyof EnvFlags)[] = [
		"mode",
		"model",
		"context",
		"tool",
		"maxImagesPerCall",
		"maxBatch",
		"cacheSize",
		"maxToolCallsPerTurn",
	];
	const flags = keys.filter((key) => env[key]);
	return flags.length ? flags.join(", ") : "none";
}

function toggleLabel(on: boolean): string {
	return on ? "ON" : "OFF";
}

async function handleInteractiveMode(
	ctx: ExtensionContext,
	persisted: VisionConfig,
	env: EnvFlags,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<boolean> {
	if (env.mode) {
		ctx.ui.notify("[vision-proxy] Env override active for mode.", "warning");
		return false;
	}
	const modeChoice = await ctx.ui.select("Select mode", [
		"fallback",
		"always",
		"off",
	]);
	const validModes: ProxyMode[] = ["fallback", "always", "off"];
	if (!validModes.includes(modeChoice as ProxyMode)) return false;
	writePersisted({ ...persisted, mode: modeChoice as ProxyMode });
	ctx.ui.notify(`Mode set to: ${modeChoice}`, "info");
	return true;
}

async function handleInteractiveModel(
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	envModel: boolean,
): Promise<void> {
	await pickVisionModel(ctx, persisted, writePersisted, envModel);
}

async function handleInteractiveContext(
	ctx: ExtensionContext,
	persisted: VisionConfig,
	env: EnvFlags,
	writePersisted: (next: VisionConfig) => VisionConfig,
	effective: VisionConfig,
): Promise<void> {
	if (env.context) {
		ctx.ui.notify("[vision-proxy] Env override active for context.", "warning");
		return;
	}
	const next = writePersisted({
		...persisted,
		includeContext: !effective.includeContext,
	});
	ctx.ui.notify(
		`Include context: ${next.includeContext ? "ON" : "OFF"}`,
		next.includeContext ? "info" : "warning",
	);
}

async function handleInteractiveTool(
	ctx: ExtensionContext,
	persisted: VisionConfig,
	env: EnvFlags,
	writePersisted: (next: VisionConfig) => VisionConfig,
	effective: VisionConfig,
): Promise<boolean> {
	if (env.tool) {
		ctx.ui.notify("[vision-proxy] Env override active for tool.", "warning");
		return false;
	}
	const nextTool = effective.tool === "on" ? "off" : "on";
	writePersisted({ ...persisted, tool: nextTool });
	ctx.ui.notify(
		`Tool: ${nextTool}`,
		nextTool === "on" ? "info" : "warning",
	);
	return true;
}

function isInvalidInt(n: number, min: number, max: number): boolean {
	return !Number.isFinite(n) || n < min || n > max;
}

async function handleInteractiveNumeric(
	ctx: ExtensionContext,
	persisted: VisionConfig,
	envKey: keyof EnvFlags,
	env: EnvFlags,
	writePersisted: (next: VisionConfig) => VisionConfig,
	effective: VisionConfig,
	configKey: NumericConfigKey,
	label: string,
	min: number,
	max: number,
): Promise<void> {
	if (env[envKey]) {
		ctx.ui.notify(`[vision-proxy] Env override active for ${label}.`, "warning");
		return;
	}
	const current = effective[configKey];
	const val = await ctx.ui.input(`${label} (${min}-${max})`, String(current));
	if (!val) return;
	const n = Number.parseInt(val, 10);
	if (isInvalidInt(n, min, max)) {
		ctx.ui.notify(`Value must be ${min}-${max}.`, "warning");
		return;
	}
	writePersisted({ ...persisted, [configKey]: n });
	ctx.ui.notify(`${label}: ${n}`, "info");
}

type InteractiveChoiceResult = { modeChanged: boolean; toolChanged: boolean };
type InteractiveHandler = () => Promise<InteractiveChoiceResult>;

async function runInteractiveChoice(
	choice: string | undefined,
	ctx: ExtensionContext,
	effective: VisionConfig,
	persisted: VisionConfig,
	env: EnvFlags,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<InteractiveChoiceResult> {
	const handlers = new Map<string, InteractiveHandler>([
		["Mode:", async () => ({
			modeChanged: await handleInteractiveMode(ctx, persisted, env, writePersisted),
			toolChanged: false,
		})],
		["Model:", async () => {
			await handleInteractiveModel(ctx, persisted, writePersisted, !!env.model);
			return { modeChanged: false, toolChanged: false };
		}],
		["Include context", async () => {
			await handleInteractiveContext(ctx, persisted, env, writePersisted, effective);
			return { modeChanged: false, toolChanged: false };
		}],
		["Tool:", async () => ({
			modeChanged: false,
			toolChanged: await handleInteractiveTool(ctx, persisted, env, writePersisted, effective),
		})],
		["Max images", async () => {
			await handleInteractiveNumeric(ctx, persisted, "maxImagesPerCall", env, writePersisted, effective, "maxImagesPerCall", "Max images per call", 1, 20);
			return { modeChanged: false, toolChanged: false };
		}],
		["Max batch", async () => {
			await handleInteractiveNumeric(ctx, persisted, "maxBatch", env, writePersisted, effective, "maxBatch", "Max batch", 1, 10);
			return { modeChanged: false, toolChanged: false };
		}],
		["Cache size", async () => {
			await handleInteractiveNumeric(ctx, persisted, "cacheSize", env, writePersisted, effective, "cacheSize", "Cache size", 0, 500);
			return { modeChanged: false, toolChanged: false };
		}],
		["Max tool calls", async () => {
			await handleInteractiveNumeric(ctx, persisted, "maxToolCallsPerTurn", env, writePersisted, effective, "maxToolCallsPerTurn", "Max tool calls per turn", -1, 100);
			return { modeChanged: false, toolChanged: false };
		}],
	]);
	if (!choice) return { modeChanged: false, toolChanged: false };
	for (const [prefix, handler] of handlers) {
		if (choice.startsWith(prefix)) return await handler();
	}
	return { modeChanged: false, toolChanged: false };
}

async function handleInteractiveConfig(
	ctx: ExtensionContext,
	effective: VisionConfig,
	persisted: VisionConfig,
	env: EnvFlags,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<InteractiveChoiceResult> {
	const friendlyEffective = friendlyModelLabel(effective, ctx.modelRegistry);
	const summary =
		`Vision proxy: ${modeLabel(effective.mode)}\n` +
		`Model: ${friendlyEffective}\n` +
		`Include context: ${toggleLabel(effective.includeContext)}\n` +
		`Tool: ${effective.tool}\n` +
		`Max images/call: ${effective.maxImagesPerCall}\n` +
		`Max batch: ${effective.maxBatch}\n` +
		`Cache size: ${effective.cacheSize}\n` +
		`Max tool calls/turn: ${effective.maxToolCallsPerTurn === -1 ? "unlimited" : effective.maxToolCallsPerTurn}\n` +
		`Env overrides: ${formatEnvOverrides(env)}\n`;

	if (!ctx.hasUI) {
		ctx.ui.notify(
			summary +
				`\nCommands: /vision-proxy fallback|always|off | pick | model provider/model-id | context on|off | tool on|off | max-images-per-call <n> | max-batch <n> | cache-size <n> | max-tool-calls-per-turn <n>`,
			"info",
		);
		return { modeChanged: false, toolChanged: false };
	}

	const choice = (await ctx.ui.select("Vision Proxy Configuration", [
		`Mode: ${effective.mode}`,
		`Model: ${friendlyEffective}`,
		`Include context: ${toggleLabel(effective.includeContext)}`,
		`Tool: ${effective.tool}`,
		`Max images/call: ${effective.maxImagesPerCall}`,
		`Max batch: ${effective.maxBatch}`,
		`Cache size: ${effective.cacheSize}`,
		`Max tool calls/turn: ${effective.maxToolCallsPerTurn === -1 ? "unlimited" : effective.maxToolCallsPerTurn}`,
	])) as string;

	return await runInteractiveChoice(choice, ctx, effective, persisted, env, writePersisted);
}

async function handleGroundingModelsList(
	ctx: ExtensionContext,
	effective: VisionConfig,
): Promise<void> {
	const gmEntries = Object.entries(effective.groundingModels);
	if (gmEntries.length === 0) {
		ctx.ui.notify("[vision-proxy] No grounding models configured.", "info");
		return;
	}
	const lines = gmEntries.map(([k, v]) => `  ${k} → ${v.format}`).join("\n");
	ctx.ui.notify(`[vision-proxy] Grounding models:\n${lines}`, "info");
}

async function handleGroundingModelsReset(
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<void> {
	writePersisted({
		...persisted,
		groundingModels: { ...DEFAULT_CONFIG.groundingModels },
	});
	ctx.ui.notify("[vision-proxy] Grounding models reset to defaults.", "info");
}

async function parseGroundingModelAdd(
	gmValue: string,
	ctx: ExtensionContext,
): Promise<{ modelKey: string; format: GroundingFormat } | null> {
	const gmTokens = gmValue.split(/\s+/);
	const modelKey = gmTokens[0]!;
	const fmtIdx = gmTokens.indexOf("--format");
	let format: GroundingFormat | undefined;
	if (fmtIdx >= 0 && gmTokens[fmtIdx + 1]) {
		const parsed = parseGroundingFormat(gmTokens[fmtIdx + 1]!);
		if (!parsed) {
			ctx.ui.notify(
				`[vision-proxy] Invalid format "${gmTokens[fmtIdx + 1]}". Valid: ${VALID_GROUNDING_FORMATS.join(", ")}`,
				"warning",
			);
			return null;
		}
		format = parsed;
	} else {
		format = "qwen_pixels";
	}
	return { modelKey, format };
}

async function confirmGroundingExcluded(
	modelKey: string,
	format: GroundingFormat,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (!isGroundingExcluded(modelKey)) return true;
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`[vision-proxy] Warning: ${modelKey} is not designed for grounding. Adding with format ${format}.`,
			"warning",
		);
		return true;
	}
	const confirm = await ctx.ui.select(
		`Warning: ${modelKey} is not designed for grounding output. Coordinates may be unreliable. Continue?`,
		["Yes, add anyway", "Cancel"],
	);
	if (confirm !== "Yes, add anyway") {
		ctx.ui.notify("[vision-proxy] Cancelled.", "info");
		return false;
	}
	return true;
}

function showGroundingAddUsage(ctx: ExtensionContext): void {
	ctx.ui.notify(
		"Usage: /vision-proxy grounding-models add <provider/model-id> [--format <fmt>]",
		"warning",
	);
}

function maybeGroundingFormatNote(ctx: ExtensionContext, hasExplicitFormat: boolean): void {
	if (hasExplicitFormat) return;
	ctx.ui.notify(
		`[vision-proxy] Note: defaulting to qwen_pixels format. Use --format to specify.`,
		"info",
	);
}

async function handleGroundingModelsAdd(
	gmValue: string,
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<void> {
	if (!gmValue) {
		showGroundingAddUsage(ctx);
		return;
	}
	const parsed = await parseGroundingModelAdd(gmValue, ctx);
	if (!parsed) return;
	const { modelKey, format } = parsed;
	const gmTokens = gmValue.split(/\s+/);
	const hasExplicitFormat = gmTokens.includes("--format");
	const confirmed = await confirmGroundingExcluded(modelKey, format, ctx);
	if (!confirmed) return;
	maybeGroundingFormatNote(ctx, hasExplicitFormat);
	const updated = {
		...persisted.groundingModels,
		[modelKey]: { format },
	};
	writePersisted({ ...persisted, groundingModels: updated });
	ctx.ui.notify(
		`[vision-proxy] Added ${modelKey} with format ${format}.`,
		"info",
	);
}

async function handleGroundingModelsRemove(
	gmValue: string,
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<void> {
	if (!gmValue) {
		ctx.ui.notify(
			"Usage: /vision-proxy grounding-models remove <provider/model-id>",
			"warning",
		);
		return;
	}
	const modelKey = gmValue.split(/\s+/)[0]!;
	if (!persisted.groundingModels[modelKey]) {
		ctx.ui.notify(
			`[vision-proxy] ${modelKey} is not in the grounding models list.`,
			"warning",
		);
		return;
	}
	const updated = { ...persisted.groundingModels };
	delete updated[modelKey];
	writePersisted({ ...persisted, groundingModels: updated });
	ctx.ui.notify(
		`[vision-proxy] Removed ${modelKey} from grounding models.`,
		"info",
	);
}

function handleGroundingModelsUsage(ctx: ExtensionContext): void {
	ctx.ui.notify(
		"Usage: /vision-proxy grounding-models <list|reset|add|remove>\n" +
			" list - show configured models\n" +
			" reset - restore defaults\n" +
			" add <provider/id> [--format <f>] - add a model\n" +
			" remove <provider/id> - remove a model",
		"info",
	);
}

async function handleGroundingModelsCommand(
	value: string,
	ctx: ExtensionContext,
	persisted: VisionConfig,
	effective: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<void> {
	const { sub: gmSub, value: gmValue } = splitSubcommand(value);
	const handler = (
		{
			list: () => handleGroundingModelsList(ctx, effective),
			reset: () => handleGroundingModelsReset(ctx, persisted, writePersisted),
			add: () => handleGroundingModelsAdd(gmValue, ctx, persisted, writePersisted),
			remove: () => handleGroundingModelsRemove(gmValue, ctx, persisted, writePersisted),
		} as Record<string, () => Promise<void> | undefined>
	)[gmSub];
	if (handler) {
		await handler();
	} else {
		handleGroundingModelsUsage(ctx);
	}
}

	// ── /vision-proxy command ─────────────────────────────────────────
export async function commandHandler(
args: string,
ctx: ExtensionContext,
pi: ExtensionAPI,
_fileConfig: Partial<VisionConfig>,
): Promise<boolean> {
	const entries = ctx.sessionManager.getEntries();
	const persisted = persistedBase(entries, _fileConfig);
	const effective = resolveConfig(entries, process.env, _fileConfig);
	const env = envFlags();
	const arg = args.trim();
	const { sub, value } = splitSubcommand(arg);

	const writePersisted = (next: VisionConfig) => {
		const validated = sanitize(next);
		pi.appendEntry(CUSTOM_TYPE_CONFIG, validated);
		// Persist to file so settings survive new sessions
		writePersistentFile(validated);
		_fileConfig = validated;
		const eff = resolveConfig(
			ctx.sessionManager.getEntries(),
			process.env,
			_fileConfig,
		);
		ctx.ui.setStatus(
			"vision-proxy",
			`vision-proxy: ${eff.mode} → ${friendlyModelLabel(eff, ctx.modelRegistry)}${eff.tool === "on" && eff.mode !== "off" ? " [+tool]" : ""}`,
		);
		return validated;
	};

	const dispatchContext: CommandDispatchContext = {
		sub,
		value,
		valueLower: value.toLowerCase(),
		ctx,
		persisted,
		effective,
		env,
		writePersisted,
	};

	const handler = COMMAND_DISPATCH[sub];
	let sync = false;
	if (handler) {
		sync = await handler(dispatchContext);
	} else {
		const { modeChanged, toolChanged } = await handleInteractiveConfig(
			ctx,
			effective,
			persisted,
			env,
			writePersisted,
		);
		sync = modeChanged || toolChanged;
	}
	return sync;
}
