#!/usr/bin/env node
/**
 * PHASE 1 PROTOTYPE SPIKE - throwaway.
 *
 * `vp hook` reads the agent's hook event JSON from stdin and emits a fake
 * `additionalContext` for UserPromptSubmit and PreToolUse Read(image) events.
 * No real `vp analyze` call yet; the description is a static placeholder so we
 * can validate end-to-end that additionalContext reaches the model in both
 * Claude Code and Codex before committing to the full install/uninstall rewrite.
 *
 * Fail-open: on any unrecognized event or parse error, exit 0 with no output.
 */
import { readFileSync } from "node:fs";

const IMAGE_EXT = new Set([
	"jpg",
	"jpeg",
	"png",
	"gif",
	"webp",
	"bmp",
	"tiff",
	"tif",
	"ico",
	"avif",
]);

interface HookEvent {
	hook_event_name?: string;
	hookEventName?: string;
	prompt?: string;
	tool_name?: string;
	toolName?: string;
	tool_input?: { file_path?: unknown; path?: unknown };
	tool_use_id?: string;
}

function readEvent(): HookEvent | undefined {
	let raw: string;
	try {
		raw = readFileSync(0, "utf8");
	} catch {
		process.stderr.write("[vision-proxy hook] could not read stdin\n");
		return undefined;
	}
	try {
		return JSON.parse(raw) as HookEvent;
	} catch {
		process.stderr.write("[vision-proxy hook] stdin was not valid JSON\n");
		return undefined;
	}
}

function isImagePath(p: string | undefined): boolean {
	if (!p || typeof p !== "string") return false;
	const ext = p.split(".").pop()?.toLowerCase();
	return ext !== undefined && IMAGE_EXT.has(ext);
}

function emit(eventName: string, context: string): void {
	process.stdout.write(
		`${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: eventName,
				additionalContext: context,
			},
		})}\n`,
	);
}

/**
 * Static fake description used by the spike. The real implementation will
 * shell out to `vp analyze <paths>` and forward its fenced output here.
 */
function fakeDescription(paths: string[]): string {
	const list = paths.join(", ");
	return `[vision-proxy] UNTRUSTED description of ${list}: A prototype placeholder image showing a test pattern with colored bars and a timestamp overlay. (SPIKE: not a real vision-model description.)`;
}

export function runHook(): void {
	const event = readEvent();
	if (!event) return; // fail-open

	const eventName = event.hook_event_name ?? event.hookEventName;

	if (eventName === "UserPromptSubmit") {
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		// Minimal extraction: pull absolute/relative paths ending in an image ext.
		const matches = prompt.matchAll(/\S+\.(?:jpg|jpeg|png|gif|webp|bmp|tiff|tif|ico|avif)\b/gi);
		const paths = [...new Set([...matches].map((m) => m[0]!))];
		if (paths.length === 0) return; // no images: proceed unchanged
		emit("UserPromptSubmit", fakeDescription(paths));
		return;
	}

	if (eventName === "PreToolUse") {
		const toolName = event.tool_name ?? event.toolName;
		if (toolName !== "Read") return; // not a Read call: proceed unchanged
		const input = event.tool_input ?? {};
		const filePath =
			typeof input.file_path === "string"
				? input.file_path
				: typeof input.path === "string"
					? input.path
					: undefined;
		if (!isImagePath(filePath)) return; // not an image: proceed unchanged
		emit("PreToolUse", fakeDescription([filePath!]));
		return;
	}

	// Unrecognized event: fail-open.
}
