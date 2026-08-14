#!/usr/bin/env node
/**
 * Vision proxy UserPromptSubmit shim for Claude Code.
 *
 * Claude Code invokes this once per user turn, piping the hook event JSON to
 * stdin. We extract image paths from the prompt, shell out to `vp analyze`,
 * and print the fenced description as `additionalContext` so Claude sees it as
 * a system note.
 *
 * Fail-open: on any error (missing vp binary, no API key, timeout) we exit 0
 * with no stdout and a note on stderr, so the agent proceeds unchanged. The
 * hook also enforces its own timeout so it never exhausts the agent's turn.
 *
 * The fenced description is attacker-controlled text, so the fence stays on by
 * default inside `vp analyze`; this shim only forwards it.
 */
import { emit, extractImagePaths, readEvent, runVP } from "./shared.mjs";

function main() {
	const event = readEvent();
	if (!event) return;
	const prompt = typeof event.prompt === "string" ? event.prompt : "";
	const images = extractImagePaths(prompt);
	if (images.length === 0) return; // No images: proceed unchanged.

	const description = runVP(images);
	if (!description) return;
	emit(description);
}

main();
