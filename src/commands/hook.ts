/**
 * `vp hook` — agent hook dispatcher.
 *
 * Claude Code and Codex both invoke this subcommand as a hook, piping the event
 * JSON to stdin. It reads the event, routes on `hook_event_name`, and emits
 * `hookSpecificOutput.additionalContext` so the agent sees an image description
 * as context.
 *
 * Supported event types:
 *   - `UserPromptSubmit`  extract image paths from `event.prompt`, run
 *                         `vp analyze`, emit the fenced description.
 *   - `PreToolUse`        when `tool_name === "Read"` and `tool_input.file_path`
 *                         is an image, run `vp analyze`, emit the description.
 *
 * Fail-open: on any error it exits 0 with no stdout, so the agent proceeds
 * unchanged. Image-derived text is attacker-controlled, so the analyzer fence
 * stays on.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Known image file extensions (lowercased, no dot). */
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "ico", "avif"];

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Exit code emitted on a hard (non-fail-open) usage error. */
export const HOOK_USAGE_ERROR = 2;

/** Resolve the `vp` binary path, preferring an explicit override/env. */
export function resolveVpBin(): string {
	const env = process.env.VP_BIN;
	if (env?.trim()) return env;
	// `vp` invoked via the shim-less hook is always the real binary. Fall back to
	// PATH so a dev run (`node src/cli.ts hook`) without VP_BIN still works.
	return "vp";
}

/** Whether a file path ends in a known image extension. */
export function isImagePath(p: string | undefined | null): boolean {
	if (!p || typeof p !== "string") return false;
	const ext = p.split(".").pop()?.toLowerCase();
	return !!ext && IMAGE_EXT.includes(ext);
}

/** Extract candidate absolute/absolute-like image paths from prompt text. */
export function extractImagePaths(text: string): string[] {
	const paths = new Set<string>();
	const add = (p: string) => {
		const t = (p || "").trim();
		if (t) paths.add(t);
	};
	// Pass 1: pi-clipboard temp files.
	const re1 =
		/(?:^|[\s"'])([a-zA-Z]:[/\\][^\s"'*?|]*?pi-clipboard-[a-f0-9-]+\.[a-zA-Z0-9]+|\/[^\s"'*?|]*?pi-clipboard-[a-f0-9-]+\.[a-zA-Z0-9]+)/gim;
	for (const m of text.matchAll(re1)) add(m[1]);
	// Pass 2: image paths with a recognized prefix (absolute, ~, drive).
	// Allow spaces in directory/file names while stopping at quotes, wildcards,
	// pipes, and newlines so one prompt can safely mention multiple images.
	const re2 = new RegExp(
		`(?:^|[\\s"'(])((?:[a-zA-Z]:[/\\\\]|/|~)[^"'*?|\\n]*?[/\\\\][^"'*?|\\n]*?\\.(?:${IMAGE_EXT.join("|")}))\\b`,
		"gi",
	);
	for (const m of text.matchAll(re2)) add(m[1]);
	// Pass 3: relative ./ and ../ paths.
	const re3 = new RegExp(
		`(?:^|[\\s"'(])(\\.\\.?/[^"'*?|\\n]*?\\.(?:${IMAGE_EXT.join("|")}))\\b`,
		"gi",
	);
	for (const m of text.matchAll(re3)) add(m[1]);
	return [...paths];
}

/**
 * Resolve a path that may be relative against `cwd` (from the hook event).
 * Keeps absolute/tilde paths as-is; only resolves bare relative ones.
 */
export function resolveImagePath(p: string | undefined | null, cwd?: string): string | null {
	if (!p) return null;
	if (p.startsWith("/") || p.startsWith("~") || /^[a-zA-Z]:[/\\]/.test(p)) {
		return p;
	}
	if (cwd && (p.startsWith("./") || p.startsWith("../"))) {
		try {
			return resolve(cwd, p);
		} catch {
			return p;
		}
	}
	return p;
}

/** Read and parse the hook event JSON from stdin. Returns null on any failure. */
export function readEvent(): Record<string, unknown> | null {
	let raw: string;
	try {
		raw = readFileSync(0, "utf8");
	} catch {
		process.stderr.write("[vision-proxy] could not read hook event from stdin\n");
		return null;
	}
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		process.stderr.write("[vision-proxy] hook event on stdin was not valid JSON\n");
		return null;
	}
}

/**
 * Parse the file path a `PreToolUse Read` event targets.
 * Both agents send `tool_input` as arbitrary JSON; the Read tool uses
 * `file_path`, with `path` as a defensive fallback. Resolves relative paths
 * against `cwd`. Returns null when the event is not a Read of an image.
 */
export function readToolFilePath(event: Record<string, unknown>): string | null {
	const toolName = (event.tool_name ?? event.toolName) as string | undefined;
	if (toolName !== "Read") return null;
	const toolInput = (event.tool_input ?? event.toolInput ?? {}) as Record<string, unknown>;
	const file = (toolInput.file_path ?? toolInput.path) as string | undefined;
	if (!isImagePath(file)) return null;
	return resolveImagePath(file, event.cwd as string | undefined);
}

/**
 * Run `vp analyze <images>` and return the fenced description, or null on failure.
 * An optional `question` is forwarded as `--question` so the vision model can
 * tailor the description.
 */
export function runAnalyze(images: string[], question?: string): string | null {
	if (images.length === 0) return null;
	const vp = resolveVpBin();
	const codexCap = Number(process.env.VP_MAX_OUTPUT_TOKENS ?? 2000);
	const args = ["analyze", ...images, "--max-output-tokens", String(codexCap)];
	if (question?.trim()) args.push("--question", question.trim());
	const result = spawnSync(vp, args, {
		encoding: "utf8",
		timeout: Number(process.env.VP_HOOK_TIMEOUT_MS ?? 30000),
		maxBuffer: MAX_BUFFER_BYTES,
	});
	if (result.error) {
		if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
			process.stderr.write(`[vision-proxy] vp binary not found: ${vp}\n`);
		} else {
			process.stderr.write("[vision-proxy] vp analyze failed or timed out\n");
		}
		return null;
	}
	if (result.status !== 0 || !result.stdout.trim()) {
		process.stderr.write(`[vision-proxy] vp analyze exited with status ${result.status ?? "?"}\n`);
		return null;
	}
	return result.stdout.trimEnd();
}

/** Write the hook output JSON both Claude Code and Codex accept. */
export function emit(
	eventName: string,
	description: string,
	permissionDecision?: "allow" | "deny" | "ask",
): void {
	const hookSpecificOutput: Record<string, unknown> = {
		hookEventName: eventName,
		additionalContext: description,
	};
	if (permissionDecision) {
		hookSpecificOutput.permissionDecision = permissionDecision;
		hookSpecificOutput.permissionDecisionReason =
			"Image read intercepted by vision-proxy; see additionalContext for the description.";
	}
	process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
}

/**
 * Hook main loop. Reads the event, routes on `hook_event_name`, shells out to
 * `vp analyze`, and emits the description. Returns early (fail-open) on any
 * error or when no images are found.
 */
/**
 * Prefix a vision-proxy description with an explicit instruction telling the
 * agent not to use the Read tool on image files and to use the description as
 * the image content. For follow-up questions, the agent should ask in the
 * prompt instead of reading the file again.
 */
function withImageInstruction(description: string): string {
	return (
		"Do not use the Read tool on image files. " +
		"vision-proxy has already routed the image(s) through a vision-input model " +
		"and produced the description below. " +
		"Treat that description as the image content. " +
		"If you need a more specific or detailed analysis, ask in the prompt instead of reading the file.\n\n" +
		description
	);
}

export function runHook(event: Record<string, unknown> | null): void {
	if (!event) return;
	const eventName = (event.hook_event_name ?? event.hookEventName) as string | undefined;
	if (eventName === "UserPromptSubmit") {
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		const images = extractImagePaths(prompt);
		if (images.length === 0) return;
		// Pass the user's prompt as the analysis question so the vision model
		// can tailor the description to what the user is asking.
		const description = runAnalyze(images, prompt);
		if (!description) return;
		emit("UserPromptSubmit", withImageInstruction(description));
		return;
	}
	if (eventName === "PreToolUse") {
		const file = readToolFilePath(event);
		if (!file) return;
		const description = runAnalyze([file]);
		if (!description) return;
		// Deny the native Read so Claude Code does not emit an "unsupported image"
		// failure, while the description above is injected as additionalContext.
		emit("PreToolUse", withImageInstruction(description), "deny");
		return;
	}
	// Unrecognized event type: proceed unchanged.
}
