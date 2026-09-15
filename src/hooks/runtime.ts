/**
 * Canonical standalone hook runtime.
 *
 * Single home for the analysis policy shared by every generated host artifact
 * (Claude/Codex stdio hook script, Pi extension, opencode plugin): image path
 * classification, path extraction, env parsing, reminder and instruction
 * rendering, vp command resolution, and analyze argument construction. Each
 * host adapter calls into this policy and owns only its lifecycle translation:
 * event shapes, image-cache refs (Claude/Codex only), mode gating (Pi only),
 * sync/async executors, and deny/output shapes.
 *
 * Standalone constraint: the generated artifacts must run with no
 * vision-proxy package present (plain npx tsx, Pi jiti, opencode plugin
 * loader), so this module ships its policy in two shapes from one source of
 * truth:
 *
 * - real functions below, which repo unit tests exercise directly
 *   (`vpEntryToSpawn` is the one exception: it lives in `src/vp-entry.ts`,
 *   the single source shared with the update notifier, and is re-exported
 *   here so the command and test API is unchanged);
 * - HOOK_RUNTIME_SOURCE, a standalone source string composed from those same
 *   functions via toString and inlined into each emitted file at generate()
 *   time by the per-host source modules.
 *
 * Rules for every function composed into HOOK_RUNTIME_SOURCE (enforced by
 * golden tests on the final artifacts):
 * - no backtick and no dollar-sign-plus-brace anywhere in the body, including
 *   comments, because host modules embed the source with String.raw;
 * - no imports beyond what each generated file already provides (node:os
 *   homedir, node:path join/resolve, and the process global);
 * - plain function declarations with no export keyword, so toString yields a
 *   clean function statement in every engine.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { vpEntryToSpawn } from "../vp-entry.ts";

/** Known image file extensions (lowercased, no dot). Shared by every host adapter. */
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "ico", "avif"];

/**
 * Marker prefix on injected reminders. Hosts whose lifecycle re-fires for the
 * same message (Pi context, opencode chat.message) strip their own prior
 * reminders by this prefix so context never stacks duplicates.
 */
const REMINDER_MARKER = "[vision-proxy:read-reminder]";

/** Shared VP_HOOK_TIMEOUT_MS default and accepted range. */
const DEFAULT_HOOK_TIMEOUT_MS = 30000;
const MIN_HOOK_TIMEOUT_MS = 1000;
const MAX_HOOK_TIMEOUT_MS = 600000;

/** Shared VP_MAX_OUTPUT_TOKENS default and accepted range. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const MIN_MAX_OUTPUT_TOKENS = 1;
const MAX_MAX_OUTPUT_TOKENS = 1000000;

/** Shared cap on captured vp analyze output. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Default analyzer command for generated artifacts. */
const DEFAULT_VP_BIN = "vp";

function parsePositiveInt(raw: unknown, fallback: number, min: number, max: number): number {
	var n = parseInt(raw == null ? "" : String(raw), 10);
	if (!Number.isFinite(n) || n < min || n > max) return fallback;
	return n;
}

function hookTimeoutMs(raw: unknown): number {
	return parsePositiveInt(raw, DEFAULT_HOOK_TIMEOUT_MS, MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
}

function maxOutputTokens(raw: unknown): number {
	return parsePositiveInt(
		raw,
		DEFAULT_MAX_OUTPUT_TOKENS,
		MIN_MAX_OUTPUT_TOKENS,
		MAX_MAX_OUTPUT_TOKENS,
	);
}

// NOTE: vpEntryToSpawn is intentionally not defined here. It lives in
// src/vp-entry.ts (shared with the update notifier) and is re-exported
// through this module's export list so the command and test API is unchanged.

function resolveVpBin(): string {
	var env = process.env.VP_BIN;
	if (env?.trim()) return env.trim();
	return DEFAULT_VP_BIN;
}

function buildAnalyzeArgs(
	images: string[],
	maxTokens: number,
	question?: string,
	context?: string,
): { command: string; args: string[] } {
	var vp = resolveVpBin();
	var prefix = vpEntryToSpawn(vp);
	var args = prefix.args.concat(["analyze"], images, ["--max-output-tokens", String(maxTokens)]);
	// biome-ignore lint/style/useTemplate: generated source must stay free of backticks.
	if (question) args = args.concat(["--question=" + question.replace(/\0/g, "")]);
	// biome-ignore lint/style/useTemplate: generated source must stay free of backticks.
	if (context) args = args.concat(["--context=" + context.replace(/\0/g, "")]);
	return { command: prefix.command, args: args };
}

/**
 * Build the JSON payload for --prompt-stdin transport.
 *
 * Hosts pass user text via stdin (not argv) so prompts never appear in process
 * listings. Returns undefined when both sides are empty so callers can omit
 * the flag entirely. NUL bytes are stripped to match the argv contract.
 */
/** Build a sanitized JSON payload for secure prompt transport.
 * @tags hooks, transport, security
 */
function buildPromptStdinPayload(question?: string, context?: string): string | undefined {
	var q = question ? question.replace(/\0/g, "") : "";
	var c = context ? context.replace(/\0/g, "") : "";
	if (!q && !c) return undefined;
	return JSON.stringify({ question: q, context: c });
}

/**
 * Build a vp analyze invocation that carries question/context via stdin.
 *
 * Args carry only --prompt-stdin (never --question/--context), so user text
 * stays out of argv; the caller writes the returned stdin string to the
 * child's stdin. Direct --question/--context argv remains supported by
 * buildAnalyzeArgs for interactive CLI use.
 */
/** Build a host invocation that keeps prompt text out of argv.
 * @tags hooks, transport, security
 */
function buildAnalyzeStdinInvocation(
	images: string[],
	maxTokens: number,
	question?: string,
	context?: string,
): { command: string; args: string[]; stdin?: string } {
	var vp = resolveVpBin();
	var prefix = vpEntryToSpawn(vp);
	var args = prefix.args.concat(["analyze"], images, ["--max-output-tokens", String(maxTokens)]);
	var payload = buildPromptStdinPayload(question, context);
	if (payload !== undefined) args = args.concat(["--prompt-stdin"]);
	return { command: prefix.command, args: args, stdin: payload };
}

/** Verbatim last-8 conversational windows, mirroring core.ts. */
const RECENT_MESSAGE_COUNT = 8;
const ASSISTANT_TRUNCATE_CHARS = 500;
/** Maximum serialized conversation context sent to the provider.
 * @tags hooks, context, limits
 */
const CONTEXT_MAX_CHARS = 3000;

function extractMessageText(content: unknown): string {
	// Accept both pre-extracted strings and raw content blocks (string or
	// TextContent arrays), so Pi AgentMessage shapes and stdio transcript
	// JSONL entries share one parser.
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	var parts: string[] = [];
	for (let i = 0; i < content.length; i++) {
		const c = content[i] as { type?: unknown; text?: unknown };
		if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
	}
	return parts.join(" ");
}

function truncateBuiltContext(result: string): string {
	if (result.length <= CONTEXT_MAX_CHARS) return result;
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	return "…" + result.slice(-CONTEXT_MAX_CHARS);
}

/** Build the bounded user/assistant context block for a host adapter.
 * @tags hooks, context, limits
 */
function buildConversationContext(
	messages: Array<{ role: string; text?: unknown; content?: unknown }>,
): string {
	var recent: Array<{ role: string; text?: unknown; content?: unknown }> = [];
	for (const m of messages) {
		if (m && (m.role === "user" || m.role === "assistant")) recent.push(m);
	}
	if (recent.length > RECENT_MESSAGE_COUNT) recent = recent.slice(-RECENT_MESSAGE_COUNT);
	const lines: string[] = [];
	for (const entry of recent) {
		const raw = entry.text !== undefined ? entry.text : entry.content;
		const text = extractMessageText(raw);
		if (!text) continue;
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		if (entry.role === "user") lines.push("User: " + text);
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		else lines.push("Assistant: " + text.slice(0, ASSISTANT_TRUNCATE_CHARS));
	}
	return truncateBuiltContext(lines.join("\n"));
}

/** VP_INCLUDE_CONTEXT gate. Defaults true to match the core.ts default. */
function includeContextEnabled(env: Record<string, string | undefined>): boolean {
	var raw = env ? env.VP_INCLUDE_CONTEXT : undefined;
	if (raw === undefined) return true;
	var v = String(raw).toLowerCase();
	if (v === "0" || v === "false" || v === "no" || v === "off") return false;
	if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
	return true;
}

function isImagePath(p: unknown): boolean {
	if (!p || typeof p !== "string") return false;
	var parts = p.split(".");
	var ext = (parts.pop() || "").toLowerCase();
	return ext !== "" && IMAGE_EXT.indexOf(ext) !== -1;
}

function resolveImagePath(p: string | undefined | null, cwd?: string): string | null {
	if (!p) return null;
	var home: string | undefined;
	// Expand a leading tilde: Node fs and spawn APIs do not expand it, so an
	// unexpanded path would fail existsSync guards and be silently dropped.
	// Honor process.env.HOME first so isolated or non-standard homes resolve.
	if (p === "~" || p.indexOf("~/") === 0) {
		home = process.env.HOME || homedir();
		if (home) return p === "~" ? home : join(home, p.slice(2));
	}
	if (p.charAt(0) === "/" || p.charAt(0) === "~" || /^[a-zA-Z]:[/\\]/.test(p)) return p;
	if (cwd && (p.indexOf("./") === 0 || p.indexOf("../") === 0)) {
		try {
			return resolve(cwd, p);
		} catch {
			return p;
		}
	}
	return p;
}

function extractImagePaths(text: string): string[] {
	// Two passes, both anchored to a delimiter (start-of-text or
	// whitespace/quote/bracket/comma/semicolon) so words like nota/path.jpeg
	// do not match: absolute-ish paths (drive letter, slash, or tilde prefix)
	// and relative paths starting with ./ or ../. Clipboard temp files such as
	// /tmp/pi-clipboard-<id>.png match the absolute pass with no special case.
	// Trailing prose punctuation is trimmed and values containing // are
	// rejected so URLs never match.
	var found: string[] = [];
	var seen: string[] = [];
	var add = (raw: string | undefined): void => {
		var t = (raw == null ? "" : raw).trim().replace(/[.,;:!?)\]}>'"]+$/, "");
		if (!t || t.indexOf("//") !== -1) return;
		if (seen.indexOf(t) !== -1) return;
		seen.push(t);
		found.push(t);
	};
	var D = "[\\s'\"()\\[\\],;]";
	// Keep spaces inside a candidate path. The non-greedy suffix stops at the
	// first recognized image extension, while quotes, wildcards, pipes, and
	// newlines remain hard boundaries for prose and shell-like input.
	var B = "[^'\"()*?|\\n]";
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var EXT = "(?:" + IMAGE_EXT.join("|") + ")";
	var reAbs = new RegExp(
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		"(^|" + D + ")((?:[a-zA-Z]:[/\\\\]|[/~])" + B + "*?\\." + EXT + ")\\b",
		"gi",
	);
	for (const m of text.matchAll(reAbs)) add(m[2]);
	// Also match paths without spaces so a non-image path cannot swallow a
	// later image path into one broad candidate.
	var BW = "[^'\\\"()*?|\\s]";
	var reAbsTight = new RegExp(
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		"(^|" + D + ")((?:[a-zA-Z]:[/\\\\]|[/~])" + BW + "*?\\." + EXT + ")\\b",
		"gi",
	);
	for (const m of text.matchAll(reAbsTight)) add(m[2]);
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var reRel = new RegExp("(^|" + D + ")((?:\\.\\.?/)" + B + "*?\\." + EXT + ")\\b", "gi");
	for (const m of text.matchAll(reRel)) add(m[2]);
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var reRelTight = new RegExp("(^|" + D + ")((?:\\.\\.?/)" + BW + "*?\\." + EXT + ")\\b", "gi");
	for (const m of text.matchAll(reRelTight)) add(m[2]);
	return found;
}

function withImageInstruction(
	description: string,
	marker?: string,
	toolWord: string = "Read",
): string {
	// Hosts whose lifecycle re-fires (opencode) pass the shared marker so the
	// injected text stays recognizable; single-fire hosts pass none and keep
	// their historical marker-free deny shape.
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var prefix = marker ? marker + " " : "";
	return (
		prefix +
		"Do not use the " +
		toolWord +
		" tool on image files. " +
		"vision-proxy has already routed the image(s) through a vision-input model " +
		"and produced the description below. " +
		"Treat that description as the image content. " +
		"If you need a more specific or detailed analysis, ask in the prompt instead of reading the file.\n\n" +
		description
	);
}

function readReminder(
	paths: string[],
	marker: string | undefined,
	subject: string,
	toolWord: string,
): string {
	// Pure string work, never shells out. Subject and tool wording stay
	// parameters so each host keeps its exact historical phrasing: the stdio
	// script reminds with prompt/Read while Pi and opencode use message/read.
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var prefix = marker ? marker + " " : "";
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var listed = paths.map((p) => "- " + p).join("\n");
	return (
		prefix +
		"The user " +
		subject +
		" references the following image file(s):\n" +
		listed +
		"\n\nUse the " +
		toolWord +
		" tool on each image path to inspect it. " +
		"vision-proxy intercepts image reads and supplies a vision-model description as context. " +
		"Do not answer about an image without reading it first."
	);
}

export {
	ASSISTANT_TRUNCATE_CHARS,
	buildAnalyzeArgs,
	buildAnalyzeStdinInvocation,
	buildConversationContext,
	buildPromptStdinPayload,
	CONTEXT_MAX_CHARS,
	DEFAULT_HOOK_TIMEOUT_MS,
	DEFAULT_MAX_OUTPUT_TOKENS,
	extractImagePaths,
	hookTimeoutMs,
	IMAGE_EXT,
	includeContextEnabled,
	isImagePath,
	MAX_BUFFER_BYTES,
	MAX_HOOK_TIMEOUT_MS,
	MAX_MAX_OUTPUT_TOKENS,
	MIN_HOOK_TIMEOUT_MS,
	MIN_MAX_OUTPUT_TOKENS,
	maxOutputTokens,
	parsePositiveInt,
	RECENT_MESSAGE_COUNT,
	REMINDER_MARKER,
	readReminder,
	resolveImagePath,
	resolveVpBin,
	vpEntryToSpawn,
	withImageInstruction,
};

function constLine(name: string, value: unknown): string {
	// biome-ignore lint/style/useTemplate: plain concatenation, no template syntax involved.
	return "var " + name + " = " + JSON.stringify(value) + ";";
}

function immutableConstLine(name: string, value: unknown): string {
	// biome-ignore lint/style/useTemplate: plain concatenation, no template syntax involved.
	return "const " + name + " = " + JSON.stringify(value) + ";";
}

/**
 * Central standalone-source constraint check, shared by the golden tests.
 * Every generated artifact (after version-marker rendering) must satisfy it:
 * no backtick and no dollar-sign-plus-brace (the sources are embedded with
 * String.raw, so either sequence would corrupt or interpolate the output),
 * and no import of the installed vision-proxy package (the artifacts must
 * run with no package present). Returns one entry per violation found.
 */
export function standaloneViolations(source: string): string[] {
	const violations: string[] = [];
	if (source.indexOf("`") !== -1) violations.push("contains a backtick");
	if (source.indexOf("${") !== -1) violations.push("contains ${");
	if (/from\s+["']vision-proxy["']/.test(source))
		violations.push("imports the vision-proxy package");
	if (/require\(\s*["']vision-proxy["']\s*\)/.test(source)) {
		violations.push("requires the vision-proxy package");
	}
	return violations;
}

/**
 * Standalone source string inlined into each emitted host file at generate()
 * time. Composed from the canonical functions above via toString, so the
 * tested implementation and the shipped source cannot drift, plus constant
 * declarations rendered from the same values.
 */
export const HOOK_RUNTIME_SOURCE: string = [
	constLine("IMAGE_EXT", IMAGE_EXT),
	constLine("REMINDER_MARKER", REMINDER_MARKER),
	constLine("DEFAULT_HOOK_TIMEOUT_MS", DEFAULT_HOOK_TIMEOUT_MS),
	constLine("MIN_HOOK_TIMEOUT_MS", MIN_HOOK_TIMEOUT_MS),
	constLine("MAX_HOOK_TIMEOUT_MS", MAX_HOOK_TIMEOUT_MS),
	constLine("DEFAULT_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
	constLine("MIN_MAX_OUTPUT_TOKENS", MIN_MAX_OUTPUT_TOKENS),
	constLine("MAX_MAX_OUTPUT_TOKENS", MAX_MAX_OUTPUT_TOKENS),
	constLine("MAX_BUFFER_BYTES", MAX_BUFFER_BYTES),
	constLine("DEFAULT_VP_BIN", "vp"),
	immutableConstLine("RECENT_MESSAGE_COUNT", RECENT_MESSAGE_COUNT),
	immutableConstLine("ASSISTANT_TRUNCATE_CHARS", ASSISTANT_TRUNCATE_CHARS),
	immutableConstLine("CONTEXT_MAX_CHARS", CONTEXT_MAX_CHARS),
	parsePositiveInt.toString(),
	hookTimeoutMs.toString(),
	maxOutputTokens.toString(),
	vpEntryToSpawn.toString(),
	resolveVpBin.toString(),
	buildAnalyzeArgs.toString(),
	buildPromptStdinPayload.toString(),
	buildAnalyzeStdinInvocation.toString(),
	extractMessageText.toString(),
	truncateBuiltContext.toString(),
	buildConversationContext.toString(),
	includeContextEnabled.toString(),
	isImagePath.toString(),
	resolveImagePath.toString(),
	extractImagePaths.toString(),
	withImageInstruction.toString(),
	readReminder.toString(),
].join("\n\n");
