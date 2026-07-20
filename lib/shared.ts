import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
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

export function buildModelItems(
	models: ExtensionContext["modelRegistry"]["getAll"],
	currentProvider: string,
	currentModelId: string,
): string[] {
	return models.map((m) => {
		const isCurrent = m.provider === currentProvider && m.id === currentModelId;
		return `${m.id}${isCurrent ? " ★" : ""} [${m.provider}]`;
	});
}

export function persistModelSelection(
	m: ExtensionContext["modelRegistry"]["getAll"][number],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): VisionConfig {
	return writePersisted({
		...persisted,
		provider: m.provider,
		modelId: m.id,
	});
}

export async function handleChangeProvider(
	ctx: ExtensionContext,
	providerSet: string[],
): Promise<PickIterationResult> {
	const selected = await ctx.ui.select("Pick provider", providerSet);
	if (!selected) return { kind: "continue" };
	return { kind: "provider", provider: selected };
}

export async function handlePickedItem(
	ctx: ExtensionContext,
	picked: string | undefined,
	providerPicked: string,
	allModels: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<PickIterationResult> {
	if (!picked) return { kind: "done" };
	if (picked === CHANGE_PROVIDER_OPTION) {
		const providerSet = [
			...new Set(allModels.map((m) => m.provider)),
		].sort((a, b) => providerSortComparator(a, b, providerPicked));
		return handleChangeProvider(ctx, providerSet);
	}
	const providerModels = allModels.filter((m) => m.provider === providerPicked);
	const baseItems = buildModelItems(
		providerModels,
		persisted.provider,
		persisted.modelId,
	);
	const idx = baseItems.indexOf(picked);
	if (idx < 0) return { kind: "continue" };
	const next = persistModelSelection(
		providerModels[idx]!,
		persisted,
		writePersisted,
	);
	ctx.ui.notify(
		`Vision proxy model: ${friendlyModelLabel(next, ctx.modelRegistry)}`,
		"info",
	);
	return { kind: "done" };
}

export async function pickModelForProvider(
	ctx: ExtensionContext,
	providerPicked: string,
	allModels: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<boolean> {
	const providerModels = allModels.filter((m) => m.provider === providerPicked);
	const baseItems = buildModelItems(
		providerModels,
		persisted.provider,
		persisted.modelId,
	);
	const items = [CHANGE_PROVIDER_OPTION, ...baseItems];
	const picked = await ctx.ui.select(
		`Pick vision model for ${providerPicked}`,
		items,
	);
	const result = await handlePickedItem(
		ctx,
		picked,
		providerPicked,
		allModels,
		persisted,
		writePersisted,
	);
	return result.kind === "done";
}

export function initialProvider(
	providerSet: string[],
	currentProvider: string,
): string {
	return currentProvider || providerSet[0]!;
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
	const allModels = ctx.modelRegistry.getAll();
	if (allModels.length === 0) {
		ctx.ui.notify("[vision-proxy] No models in registry.", "error");
		return null;
	}
	return allModels;
}

/** Two-step vision model picker: choose provider first, then model. */
export async function pickVisionModel(
	ctx: ExtensionContext,
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
	envModel: boolean,
): Promise<void> {
	const allModels = prepareVisionModels(ctx, envModel);
	if (allModels === null) return;

	const currentProvider = persisted.provider;
	const providerSet = [...new Set(allModels.map((m) => m.provider))];
	providerSet.sort((a, b) => providerSortComparator(a, b, currentProvider));
	let providerPicked = initialProvider(providerSet, currentProvider);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const done = await pickModelForProvider(
			ctx,
			providerPicked,
			allModels,
			persisted,
			writePersisted,
		);
		if (done) return;
		providerPicked = initialProvider(
			providerSet,
			persisted.provider,
		);
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