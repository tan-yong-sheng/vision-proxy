import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	LRUCache,
	modelLabel,
	shouldStripImages as shouldStripImagesPure,
	type VisionConfig,
} from "../extensions/internal.js";

// ── Tool result cache (shared across calls in the session) ─────────────────
export const _toolCache = new LRUCache<string, string>(50);

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

export async function promptChangeProvider(
	ctx: ExtensionContext,
	currentProvider: string,
	allModels: ExtensionContext["modelRegistry"]["getAll"],
): Promise<string | undefined> {
	const providerSet = [
		...new Set(allModels.map((m) => m.provider)),
	].sort((a, b) => providerSortComparator(a, b, currentProvider));
	const selected = await ctx.ui.select("Pick provider", providerSet);
	if (!selected) return undefined;
	return selected;
}

export async function applyModelSelection(
	ctx: ExtensionContext,
	picked: string,
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
	const idx = baseItems.indexOf(picked);
	if (idx < 0) return false;
	const next = persistModelSelection(
		providerModels[idx]!,
		persisted,
		writePersisted,
	);
	ctx.ui.notify(
		`Vision proxy model: ${friendlyModelLabel(next, ctx.modelRegistry)}`,
		"info",
	);
	return true;
}

export type ModelPickAction =
	| { kind: "cancel" }
	| { kind: "change-provider" }
	| { kind: "select"; picked: string };

export function classifyModelPick(
	picked: string | undefined,
): ModelPickAction {
	if (!picked) return { kind: "cancel" };
	if (picked === CHANGE_PROVIDER_OPTION) return { kind: "change-provider" };
	return { kind: "select", picked };
}

export async function promptModelList(
	ctx: ExtensionContext,
	providerPicked: string,
	providerModels: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
): Promise<string | undefined> {
	const baseItems = buildModelItems(
		providerModels,
		persisted.provider,
		persisted.modelId,
	);
	const items = [CHANGE_PROVIDER_OPTION, ...baseItems];
	return ctx.ui.select(`Pick vision model for ${providerPicked}`, items);
}

export async function pickModelForProvider(
	ctx: ExtensionContext,
	providerPicked: string,
	allModels: ExtensionContext["modelRegistry"]["getAll"],
	persisted: VisionConfig,
	writePersisted: (next: VisionConfig) => VisionConfig,
): Promise<string | undefined> {
	const providerModels = allModels.filter((m) => m.provider === providerPicked);
	const picked = await promptModelList(
		ctx,
		providerPicked,
		providerModels,
		persisted,
	);
	return dispatchModelPick({
		ctx,
		picked,
		providerPicked,
		allModels,
		persisted,
		writePersisted,
	});
}

async function dispatchModelPick(args: {
	ctx: ExtensionContext;
	picked: string | undefined;
	providerPicked: string;
	allModels: ExtensionContext["modelRegistry"]["getAll"];
	persisted: VisionConfig;
	writePersisted: (next: VisionConfig) => VisionConfig;
}): Promise<string | undefined> {
	const action = classifyModelPick(args.picked);
	if (action.kind === "cancel") return undefined;
	if (action.kind === "change-provider") {
		return handleChangeProviderAction(args);
	}
	return handleSelectAction(action.picked, args);
}

async function handleChangeProviderAction(args: {
	ctx: ExtensionContext;
	providerPicked: string;
	allModels: ExtensionContext["modelRegistry"]["getAll"];
}): Promise<string> {
	const newProvider = await promptChangeProvider(
		args.ctx,
		args.providerPicked,
		args.allModels,
	);
	return newProvider ?? args.providerPicked;
}

async function handleSelectAction(
	picked: string,
	args: {
		ctx: ExtensionContext;
		providerPicked: string;
		allModels: ExtensionContext["modelRegistry"]["getAll"];
		persisted: VisionConfig;
		writePersisted: (next: VisionConfig) => VisionConfig;
	},
): Promise<string> {
	const saved = await applyModelSelection(
		args.ctx,
		picked,
		args.providerPicked,
		args.allModels,
		args.persisted,
		args.writePersisted,
	);
	return saved ? undefined as unknown as string : args.providerPicked;
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
	const visionModels = allModels.filter((m) => m.input.includes("image"));
	if (visionModels.length === 0) {
		ctx.ui.notify(
			"[vision-proxy] No vision-capable models in registry.",
			"error",
		);
		return null;
	}
	return visionModels;
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
		const nextProvider = await pickModelForProvider(
			ctx,
			providerPicked,
			allModels,
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