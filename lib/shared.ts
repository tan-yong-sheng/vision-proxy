import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	fuzzyMatches,
	LRUCache,
	modelLabel,
	shouldStripImages as shouldStripImagesPure,
	type VisionConfig,
} from "../extensions/internal.js";

// ── Tool result cache (shared across calls in the session) ─────────────────
export const _toolCache = new LRUCache<string, string>(50);

/** Maximum analyze_image tool calls per agent turn. Prevents cost runaway. */
export const MAX_TOOL_CALLS_PER_TURN = 10;

/** Current turn's tool call count (reset on each before_agent_start). */
export const _toolCallCount = { value: 0 };

/** Whether the analyze_image tool has been registered this session. */
export const _toolRegistered = { value: false };

/** Sanitize text for embedding inside XML-like tags. */
export function sanitizeXml(text: string): string {
	return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Helpers ────────────────────────────────────────────────────────────────

export const FILTER_OPTION = "🔍 Type to filter models...";
export const CHANGE_PROVIDER_OPTION = "← Change provider";

export type PickIterationResult =
	| { kind: "continue" }
	| { kind: "provider"; provider: string }
	| { kind: "done" };

export function providerSortComparator(
	a: string,
	b: string,
	currentProvider: string,
): number {
	if (a === currentProvider) return -1;
	if (b === currentProvider) return 1;
	return a.localeCompare(b);
}

export function buildProviderItems(
	providers: string[],
	vision: ExtensionContext["modelRegistry"]["getAll"],
	currentProvider: string,
): string[] {
	return providers.map((p) => {
		const count = vision.filter((m) => m.provider === p).length;
		const star = p === currentProvider ? " ★" : "";
		return `${p}${star} (${count} model${count !== 1 ? "s" : ""})`;
	});
}

export function buildModelItems(
	models: ExtensionContext["modelRegistry"]["getAll"],
	labelWidth: number,
): string[] {
	return models.map(
		(m) => `${(m.name ?? m.id).padEnd(labelWidth)} [${m.provider}]`,
	);
}

export function labelWidthForModels(
	models: ExtensionContext["modelRegistry"]["getAll"],
): number {
	return Math.min(
		40,
		Math.max(...models.map((m) => (m.name ?? m.id).length)),
	);
}

export function persistModelSelection(
	m: ExtensionContext["modelRegistry"]["getAll"][number],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	registry: ExtensionContext["modelRegistry"],
): VisionConfig {
	const next = writePersisted({
		...persisted,
		provider: m.provider,
		modelId: m.id,
	});
	return next;
}

export async function selectFromFilteredModels(
	ctx: ExtensionContext,
	filtered: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	query: string,
): Promise<boolean> {
	if (filtered.length === 1) {
		const next = persistModelSelection(
			filtered[0]!,
			persisted,
			writePersisted,
			ctx.modelRegistry,
		);
		ctx.ui.notify(
			`Vision proxy model: ${friendlyModelLabel(next, ctx.modelRegistry)}`,
			"info",
		);
		return true;
	}

	const fLabelWidth = labelWidthForModels(filtered);
	const fItems = buildModelItems(filtered, fLabelWidth);
	const fPicked = await ctx.ui.select(
		`Filter: "${query}" (${filtered.length} matches)`,
		fItems,
	);
	if (!fPicked) return false;
	const fIdx = fItems.indexOf(fPicked);
	if (fIdx < 0) return false;
	const next = persistModelSelection(
		filtered[fIdx]!,
		persisted,
		writePersisted,
		ctx.modelRegistry,
	);
	ctx.ui.notify(
		`Vision proxy model: ${friendlyModelLabel(next, ctx.modelRegistry)}`,
		"info",
	);
	return true;
}

export async function runFilterFlow(
	ctx: ExtensionContext,
	models: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<boolean> {
	const query = await ctx.ui.input(
		"Filter models",
		"Type part of a model name...",
	);
	if (!query) return false;
	const filtered = models.filter((m) => fuzzyMatches(m.name ?? m.id, query));
	if (filtered.length === 0) {
		ctx.ui.notify(
			`[vision-proxy] No models match "${query}".`,
			"warning",
		);
		return false;
	}
	return selectFromFilteredModels(
		ctx,
		filtered,
		persisted,
		writePersisted,
		query,
	);
}

export async function handleModelSelection(
	ctx: ExtensionContext,
	picked: string,
	baseItems: string[],
	models: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<boolean> {
	if (picked === FILTER_OPTION) return false;
	if (picked === CHANGE_PROVIDER_OPTION) return false;
	const baseIdx = baseItems.indexOf(picked);
	if (baseIdx < 0) return false;
	const next = persistModelSelection(
		models[baseIdx]!,
		persisted,
		writePersisted,
		ctx.modelRegistry,
	);
	ctx.ui.notify(
		`Vision proxy model: ${friendlyModelLabel(next, ctx.modelRegistry)}`,
		"info",
	);
	return true;
}

export async function handleChangeProvider(
	ctx: ExtensionContext,
	providerItems: string[],
	providerSet: string[],
): Promise<PickIterationResult> {
	const selected = await ctx.ui.select("Pick provider", providerItems);
	if (!selected) return { kind: "continue" };
	const idx = providerItems.indexOf(selected);
	if (idx < 0) return { kind: "continue" };
	return { kind: "provider", provider: providerSet[idx]! };
}

export async function handleFilterOption(
	ctx: ExtensionContext,
	models: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<PickIterationResult> {
	const done = await runFilterFlow(ctx, models, persisted, writePersisted);
	return done ? { kind: "done" } : { kind: "continue" };
}

export async function handleModelOption(
	ctx: ExtensionContext,
	picked: string,
	baseItems: string[],
	models: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<PickIterationResult> {
	const done = await handleModelSelection(
		ctx,
		picked,
		baseItems,
		models,
		persisted,
		writePersisted,
	);
	return done ? { kind: "done" } : { kind: "continue" };
}

export async function handlePickedItem(
	ctx: ExtensionContext,
	picked: string | undefined,
	baseItems: string[],
	models: ExtensionContext["modelRegistry"]["getAll"],
	providerItems: string[],
	providerSet: string[],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<PickIterationResult> {
	if (!picked) return { kind: "done" };
	if (picked === CHANGE_PROVIDER_OPTION)
		return handleChangeProvider(ctx, providerItems, providerSet);
	if (picked === FILTER_OPTION)
		return handleFilterOption(ctx, models, persisted, writePersisted);
	return handleModelOption(
		ctx,
		picked,
		baseItems,
		models,
		persisted,
		writePersisted,
	);
}

export function continueOrReturnProvider(
	result: PickIterationResult,
): string | "done" | "continue" {
	if (result.kind === "done") return "done";
	if (result.kind === "provider") return result.provider;
	return "continue";
}

export function buildSelectionItems(
	baseItems: string[],
	providerSet: string[],
): string[] {
	const items: string[] = [];
	if (providerSet.length > 1) items.push(CHANGE_PROVIDER_OPTION);
	if (baseItems.length > 8) items.push(FILTER_OPTION);
	items.push(...baseItems);
	return items;
}

export async function pickModelForProvider(
	ctx: ExtensionContext,
	providerPicked: string,
	providerSet: string[],
	providerItems: string[],
	vision: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<string | undefined> {
	const models = vision.filter((m) => m.provider === providerPicked);
	const labelWidth = labelWidthForModels(models);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const baseItems = buildModelItems(models, labelWidth);
		const items = buildSelectionItems(baseItems, providerSet);
		const picked = await ctx.ui.select(
			`Pick vision model (${providerPicked})`,
			items,
		);
		const result = await handlePickedItem(
			ctx,
			picked,
			baseItems,
			models,
			providerItems,
			providerSet,
			persisted,
			writePersisted,
		);
		const next = continueOrReturnProvider(result);
		if (next === "done") return undefined;
		if (next !== "continue") providerPicked = next;
	}
}

export function initialProvider(providerSet: string[], currentProvider: string): string {
	if (providerSet.length === 1) return providerSet[0]!;
	return currentProvider;
}

export function prepareVisionModels(
	ctx: ExtensionContext,
	envModel: boolean,
): ExtensionContext["modelRegistry"]["getAll"] | null {
	if (envModel) {
		ctx.ui.notify(
			"[vision-proxy] PI_VISION_PROXY_MODEL is set - env overrides commands. Unset to change.",
			"warning",
		);
		return null;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"[vision-proxy] Pick needs UI. Use /vision-proxy model provider/id.",
			"warning",
		);
		return null;
	}
	const vision = ctx.modelRegistry
		.getAll()
		.filter((m) => m.input.includes("image"));
	if (vision.length === 0) {
		ctx.ui.notify(
			"[vision-proxy] No vision-capable models in registry.",
			"error",
		);
		return null;
	}
	return vision;
}

/** Two-step vision model picker: choose provider first, then model. */
export async function pickVisionModel(
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	envModel: boolean,
): Promise<void> {
	const vision = prepareVisionModels(ctx, envModel);
	if (vision === null) return;

	const currentProvider = persisted.provider;
	const providerSet = [...new Set(vision.map((m) => m.provider))];
	providerSet.sort((a, b) => providerSortComparator(a, b, currentProvider));
	const providerItems = buildProviderItems(providerSet, vision, currentProvider);
	let providerPicked = initialProvider(providerSet, currentProvider);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const nextProvider = await pickModelForProvider(
			ctx,
			providerPicked,
			providerSet,
			providerItems,
			vision,
			persisted,
			writePersisted,
		);
		if (nextProvider === undefined) return;
		providerPicked = nextProvider;
	}
}

export function shouldStripImages(
	config: VisionConfig,
	model: ExtensionContext["model"],
): boolean {
	return shouldStripImagesPure(config, model?.input);
}

export function friendlyModelLabel(
	config: VisionConfig,
	registry: ExtensionContext["modelRegistry"],
): string {
	const m = registry.find(config.provider, config.modelId);
	if (m?.name) return `${m.name} [${config.provider}]`;
	return modelLabel(config);
}

/** Cached config loaded from persistent file on startup */
export const _fileConfig = { value: {} as Partial<VisionConfig> };