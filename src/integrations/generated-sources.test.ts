/**
 * Golden tests for the generated host artifacts.
 *
 * Pins the composition contract at the `generate()` seam: every emitted file
 * carries the version marker, stays standalone (no backtick/`${`, no import
 * of the installed package), inlines the tested canonical runtime verbatim,
 * keeps its host-specific adapter (event translation, executor, deny/output
 * shape), and preserves the exact historical reminder/deny wording hosts key
 * on. Any policy drift between the runtime and an artifact is a diff failure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderVersionMarker } from "../version.ts";
import { generateHookScript, stampSubmitToolWord } from "./catalog.ts";
import { HOOK_SCRIPT_SOURCE } from "./hook-script.ts";
import { PI_EXTENSION_SOURCE } from "./pi-extension.ts";
import { HOOK_RUNTIME_SOURCE, standaloneViolations } from "./runtime.ts";

// opencode removed while its v2 plugin API stabilizes.
const HOSTS: Array<{ name: string; source: string }> = [
	{ name: "claude/codex hook script", source: HOOK_SCRIPT_SOURCE },
	{ name: "pi extension", source: PI_EXTENSION_SOURCE },
];

test("every generated artifact inlines the canonical runtime verbatim", () => {
	for (const host of HOSTS) {
		assert.ok(
			host.source.includes(HOOK_RUNTIME_SOURCE),
			`${host.name} must inline HOOK_RUNTIME_SOURCE without edits`,
		);
	}
});

test("every generated artifact carries the version placeholder and renders it", () => {
	for (const host of HOSTS) {
		assert.ok(
			host.source.includes("__VP_VERSION__PLACEHOLDER__"),
			`${host.name} must carry the version placeholder`,
		);
		const rendered = host.source.replace("__VP_VERSION__PLACEHOLDER__", renderVersionMarker());
		assert.ok(!rendered.includes("__VP_VERSION__PLACEHOLDER__"), "placeholder must render away");
		assert.ok(rendered.includes(renderVersionMarker()), "rendered marker must be embedded");
	}
});

test("every rendered artifact stays standalone", () => {
	for (const host of HOSTS) {
		const rendered = host.source.replace("__VP_VERSION__PLACEHOLDER__", renderVersionMarker());
		assert.deepEqual(
			standaloneViolations(rendered),
			[],
			`${host.name} violates standalone constraints: ${standaloneViolations(rendered).join("; ")}`,
		);
	}
});

test("hook script keeps its stdio adapter: image-cache refs, spawnSync, deny shape", () => {
	assert.ok(HOOK_SCRIPT_SOURCE.includes("image-cache"), "must keep image-cache ref resolution");
	assert.ok(HOOK_SCRIPT_SOURCE.includes("IMAGE_REF_RE"), "must keep the [Image #N] pattern");
	assert.ok(HOOK_SCRIPT_SOURCE.includes("spawnSync"), "must keep the sync executor");
	assert.ok(
		HOOK_SCRIPT_SOURCE.includes("isAnalysisDisabled(process.env.VP_MODE)"),
		"must gate on the shared off-switch (VP_MODE=off stops the hook like Pi)",
	);
	assert.ok(
		HOOK_SCRIPT_SOURCE.includes("resolveHookTimeout(process.env.VP_HOOK_TIMEOUT_MS)"),
		"must read the timeout live through the shared resolver",
	);
	assert.ok(
		HOOK_SCRIPT_SOURCE.includes("hookSpecificOutput"),
		"must keep the hookSpecificOutput deny shape",
	);
	assert.ok(
		HOOK_SCRIPT_SOURCE.includes("permissionDecision"),
		"must keep the permissionDecision deny field",
	);
	assert.ok(
		HOOK_SCRIPT_SOURCE.includes("updatedInput"),
		"must keep the updatedInput rewrite field",
	);
	assert.ok(HOOK_SCRIPT_SOURCE.includes("#!/usr/bin/env -S npx tsx"), "must keep the tsx shebang");
});

test("pi extension keeps its lifecycle adapter: mode gating, abort handling, context shape", () => {
	assert.ok(PI_EXTENSION_SOURCE.includes("getMode()"), "must keep Pi mode gating");
	assert.ok(PI_EXTENSION_SOURCE.includes("cachedConfigMode"), "must keep the cached config lookup");
	assert.ok(
		!PI_EXTENSION_SOURCE.includes('from "node:buffer"'),
		"must not import node:buffer (canonical runtime guards the missing global)",
	);
	assert.ok(
		PI_EXTENSION_SOURCE.includes("utf8ByteLength"),
		"must size context through the guarded canonical helper",
	);
	assert.ok(
		PI_EXTENSION_SOURCE.includes("isAnalysisDisabled(envMode)"),
		"must decide the off-switch through the shared check",
	);
	assert.ok(
		PI_EXTENSION_SOURCE.includes("currentTimeoutMs()"),
		"must resolve the timeout live per invocation (no frozen module-load const)",
	);
	assert.ok(
		!PI_EXTENSION_SOURCE.includes("var TIMEOUT_MS = hookTimeoutMs"),
		"must not freeze the timeout at startup",
	);
	assert.ok(PI_EXTENSION_SOURCE.includes("SIGTERM"), "must keep the AbortSignal executor");
	assert.ok(PI_EXTENSION_SOURCE.includes("SIGKILL"), "must keep the force-stop executor");
	assert.ok(PI_EXTENSION_SOURCE.includes('pi.on("input"'), "must keep the input handler");
	assert.ok(PI_EXTENSION_SOURCE.includes('pi.on("context"'), "must keep the context handler");
	assert.ok(
		PI_EXTENSION_SOURCE.includes('pi.on("tool_call"'),
		"must keep the tool_call rewrite handler",
	);
	assert.ok(
		PI_EXTENSION_SOURCE.includes('pi.on("tool_result"'),
		"must keep the tool_result handler",
	);
	assert.ok(!PI_EXTENSION_SOURCE.includes("image-cache"), "must not gain image-cache refs");
});

test("generated artifacts preserve the historical reminder and deny wording", () => {
	// Submit-time wording differs deliberately per host; deny wording is shared.
	// The hook script composes its reminder via readReminder(..., "prompt",
	// SUBMIT_TOOL_WORD) — stamped to "Read" for Claude Code and "view_image"
	// for Codex at generate() time — so the golden test pins the composition
	// parameters (pinned per stamped artifact below) instead of a literal.
	assert.ok(
		HOOK_SCRIPT_SOURCE.includes('readReminder(allImages, undefined, "prompt", SUBMIT_TOOL_WORD)'),
		"hook script composes its reminder from the stamped SUBMIT_TOOL_WORD",
	);
	assert.ok(
		HOOK_SCRIPT_SOURCE.includes('var SUBMIT_TOOL_WORD = "Read";'),
		"unstamped hook source defaults the tool word to Read",
	);
	assert.ok(
		generateHookScript().includes('var SUBMIT_TOOL_WORD = "Read";'),
		"claude artifact keeps the Read reminder",
	);
	assert.ok(
		generateHookScript(undefined, "view_image").includes('var SUBMIT_TOOL_WORD = "view_image";'),
		"codex artifact names view_image in its reminder",
	);
	assert.equal(
		stampSubmitToolWord(HOOK_SCRIPT_SOURCE, "bogus" as "Read").includes(
			'var SUBMIT_TOOL_WORD = "Read";',
		),
		true,
		"unknown tool words fall back to Read",
	);
	assert.ok(
		PI_EXTENSION_SOURCE.includes('readReminder(paths, REMINDER_MARKER, "message", "read")'),
		"pi extension keeps its message/read reminder parameters",
	);
	for (const host of HOSTS) {
		assert.match(
			host.source,
			/"Do not use the "\s*\+\s*toolWord\s*\+\s*" tool on image files\./,
			`${host.name} must keep the deny instruction composition`,
		);
		assert.ok(
			host.source.includes("Treat that description as the image content."),
			`${host.name} must keep the untrusted-input instruction`,
		);
	}
});

test("every generated artifact shares the Windows-safe context-dir policy", () => {
	// POSIX mode bits are meaningless on Windows (mkdir ignores mode,
	// chmod only toggles read-only), so the strict bit check must be
	// skipped there in every writer; privacy relies on per-user temp ACL
	// inheritance. Pins the shared policy so the two adapters cannot drift.
	for (const host of HOSTS) {
		assert.ok(
			host.source.includes('process.platform !== "win32"'),
			`${host.name} must skip the POSIX mode-bit check on Windows`,
		);
	}
});

test("generated artifacts keep their fail-open and fence discipline", () => {
	for (const host of HOSTS) {
		assert.ok(
			host.source.toLowerCase().includes("fail-open"),
			`${host.name} must document fail-open behavior`,
		);
	}
	assert.ok(HOOK_SCRIPT_SOURCE.includes("exits 0"), "hook script must document exiting 0 on error");
});
