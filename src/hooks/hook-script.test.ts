/**
 * Contract tests for the Claude/Codex stdio hook-script adapter.
 *
 * Executes the generated `HOOK_SCRIPT_SOURCE` in a child process (mirroring
 * `npx tsx <script>` with a hook event on stdin) and pins the host-specific
 * contract: UserPromptSubmit is reminder-only and resolves `[Image #N]` refs
 * via the image cache with a sessionId traversal guard, while PreToolUse
 * Read shells out to `vp analyze` once and denies with
 * `hookSpecificOutput.additionalContext`. Every failure mode is fail-open
 * (exit 0, no stdout).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { test } from "node:test";
import { HOOK_SCRIPT_SOURCE } from "../hook-script.ts";

interface HookRun {
	status: number | null;
	stdout: string;
	stderr: string;
}

function writeScript(): string {
	const dir = mkdtempSync(join(tmpdir(), "vp-hook-script-test-"));
	const file = join(dir, "vision-proxy.ts");
	writeFileSync(file, HOOK_SCRIPT_SOURCE.replace("__VP_VERSION__PLACEHOLDER__", "// test marker"));
	return file;
}

/** Fake `vp` that echoes a fenced description for any `analyze` call. */
function fakeVp(): string {
	const dir = mkdtempSync(join(tmpdir(), "vp-fake-bin-"));
	const file = join(dir, "vp");
	writeFileSync(
		file,
		"#!/bin/sh\nprintf '%s\\n' '<vision_proxy_description>A red square on white.</vision_proxy_description>'\n",
	);
	chmodSync(file, 0o755);
	return file;
}

function runHook(
	script: string,
	event: Record<string, unknown>,
	env: Record<string, string> = {},
): HookRun {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", script],
		{
			input: `${JSON.stringify(event)}\n`,
			encoding: "utf8",
			env: { ...process.env, ...env },
			timeout: 60000,
		},
	);
	return {
		status: result.status,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
	};
}

function parseOutput(run: HookRun): Record<string, any> | null {
	if (!run.stdout.trim()) return null;
	return JSON.parse(run.stdout) as Record<string, any>;
}

test("UserPromptSubmit emits a Read reminder without spawning vp", () => {
	const script = writeScript();
	// VP_BIN points nowhere: if the submit path shelled out, the reminder
	// would never be emitted. Its presence proves the path is reminder-only.
	const run = runHook(
		script,
		{ hook_event_name: "UserPromptSubmit", prompt: "What is in /tmp/screenshot.png?" },
		{ VP_BIN: join(tmpdir(), "vp-definitely-absent-binary") },
	);
	assert.equal(run.status, 0);
	const out = parseOutput(run);
	assert.ok(out, "UserPromptSubmit with an image path must emit JSON");
	assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.match(out.hookSpecificOutput.additionalContext, /The user prompt references/);
	assert.match(out.hookSpecificOutput.additionalContext, /\/tmp\/screenshot\.png/);
	assert.match(out.hookSpecificOutput.additionalContext, /Use the Read tool on each image path/);
	assert.ok(!("permissionDecision" in out.hookSpecificOutput), "submit reminder must not deny");
});

test("UserPromptSubmit with no image paths emits nothing", () => {
	const script = writeScript();
	const run = runHook(script, { hook_event_name: "UserPromptSubmit", prompt: "plain text" });
	assert.equal(run.status, 0);
	assert.equal(run.stdout.trim(), "");
});

test("UserPromptSubmit resolves [Image #N] refs via the image cache", () => {
	const home = mkdtempSync(join(tmpdir(), "vp-hook-home-"));
	const configDir = join(home, ".claude");
	const sessionDir = join(configDir, "image-cache", "sess-1");
	mkdirSync(sessionDir, { recursive: true });
	const cached = join(sessionDir, "0.png");
	writeFileSync(cached, "fake-image-bytes");
	const script = writeScript();
	// The adapter prefers VP_CLAUDE_CONFIG_DIR over HOME (as does the
	// original script with CLAUDE_CONFIG_DIR), so point the config dir at the
	// isolated home explicitly; the ambient CLAUDE_CONFIG_DIR must not leak in.
	const run = runHook(
		script,
		{
			hook_event_name: "UserPromptSubmit",
			prompt: "Describe [Image #0] please",
			session_id: "sess-1",
		},
		{ HOME: home, VP_CLAUDE_CONFIG_DIR: configDir, CLAUDE_CONFIG_DIR: "" },
	);
	assert.equal(run.status, 0);
	const out = parseOutput(run);
	assert.ok(out, "cached image ref must emit a reminder");
	assert.ok(
		out.hookSpecificOutput.additionalContext.includes(cached),
		"reminder must name the cached file",
	);
});

test("UserPromptSubmit rejects sessionId traversal", () => {
	const home = mkdtempSync(join(tmpdir(), "vp-hook-home-traversal-"));
	const script = writeScript();
	const run = runHook(
		script,
		{
			hook_event_name: "UserPromptSubmit",
			prompt: "Describe [Image #0] please",
			session_id: "../evil",
		},
		{ HOME: home },
	);
	assert.equal(run.status, 0);
	assert.equal(run.stdout.trim(), "", "traversal sessionId must resolve no refs");
});

test("UserPromptSubmit ignores refs when the session cache dir is absent", () => {
	const home = mkdtempSync(join(tmpdir(), "vp-hook-home-nocache-"));
	const script = writeScript();
	const run = runHook(
		script,
		{
			hook_event_name: "UserPromptSubmit",
			prompt: "Describe [Image #0] please",
			session_id: "no-such-session",
		},
		{ HOME: home },
	);
	assert.equal(run.status, 0);
	assert.equal(run.stdout.trim(), "");
});

test("PreToolUse Read analyzes once and denies with the description", () => {
	const script = writeScript();
	const run = runHook(
		script,
		{
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/tmp/diagram.png" },
		},
		{ VP_BIN: fakeVp() },
	);
	assert.equal(run.status, 0);
	const out = parseOutput(run);
	assert.ok(out, "image Read must emit JSON");
	assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
	assert.match(out.hookSpecificOutput.additionalContext, /Do not use the Read tool on image files/);
	assert.match(out.hookSpecificOutput.additionalContext, /A red square on white/);
});

test("PreToolUse view_image analyzes its path and denies before the native read", () => {
	const script = writeScript();
	const run = runHook(
		script,
		{
			hook_event_name: "PreToolUse",
			tool_name: "view_image",
			tool_input: { path: "/tmp/diagram.png", detail: "high" },
		},
		{ VP_BIN: fakeVp() },
	);
	assert.equal(run.status, 0);
	const out = parseOutput(run);
	assert.ok(out, "view_image must emit JSON");
	assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
	assert.match(out.hookSpecificOutput.additionalContext, /A red square on white/);
});

test("PreToolUse ignores non-Read tools and non-image paths", () => {
	const script = writeScript();
	const env = { VP_BIN: fakeVp() };
	for (const event of [
		{ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/etc/hosts" } },
		{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
		{ hook_event_name: "SomeOtherEvent", prompt: "see /tmp/a.png" },
	]) {
		const run = runHook(script, event, env);
		assert.equal(run.status, 0);
		assert.equal(run.stdout.trim(), "", `must stay silent for ${JSON.stringify(event)}`);
	}
});

test("PreToolUse fails open when an image path cannot be passed to spawn", () => {
	const script = writeScript();
	const run = runHook(script, {
		hook_event_name: "PreToolUse",
		tool_name: "Read",
		tool_input: { file_path: "/tmp/image\u0000.png" },
	});
	assert.equal(run.status, 0);
	assert.equal(run.stdout.trim(), "");
	assert.match(run.stderr, /hook failed open/);
});

test("PreToolUse fails open when vp is missing or exits non-zero", () => {
	const script = writeScript();
	const event = {
		hook_event_name: "PreToolUse",
		tool_name: "Read",
		tool_input: { file_path: "/tmp/diagram.png" },
	};
	const missing = runHook(script, event, {
		VP_BIN: join(tmpdir(), "vp-definitely-absent-binary"),
	});
	assert.equal(missing.status, 0, "missing vp must still exit 0");
	assert.equal(missing.stdout.trim(), "", "missing vp must emit nothing");

	const failingDir = mkdtempSync(join(tmpdir(), "vp-failing-bin-"));
	const failing = join(failingDir, "vp");
	writeFileSync(failing, "#!/bin/sh\nexit 1\n");
	chmodSync(failing, 0o755);
	const failed = runHook(script, event, { VP_BIN: failing });
	assert.equal(failed.status, 0, "failing vp must still exit 0");
	assert.equal(failed.stdout.trim(), "", "failing vp must emit nothing");
});

/** Fake `vp` that echoes its argv inside the description so flag passing is assertable. */
function fakeVpEchoArgs(): string {
	const dir = mkdtempSync(join(tmpdir(), "vp-fake-bin-args-"));
	const file = join(dir, "vp");
	writeFileSync(
		file,
		"#!/bin/sh\nprintf '%s' '<vision_proxy_description>ARGS:'\nprintf '%s' \"$*\"\nprintf '%s' ' STDIN:'\ncat\nprintf '%s\\n' '</vision_proxy_description>'\n",
	);
	chmodSync(file, 0o755);
	return file;
}

function writeTranscript(lines: string[], root?: string): string {
	const dir = mkdtempSync(join(root ?? tmpdir(), "vp-transcript-"));
	const file = join(dir, "transcript.jsonl");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

const TRANSCRIPT_LINES = [
	JSON.stringify({ type: "user", message: { role: "user", content: "what color is it?" } }),
	JSON.stringify({
		type: "assistant",
		message: { role: "assistant", content: [{ type: "text", text: "It is red." }] },
	}),
	JSON.stringify({
		type: "file-history-snapshot",
		message: { role: "user", content: "SHOULD NOT APPEAR" },
	}),
];

test("PreToolUse forwards side-channel --question and transcript --context to vp analyze", () => {
	const home = mkdtempSync(join(tmpdir(), "vp-hook-home-qctx-"));
	const configDir = join(home, ".claude");
	const script = writeScript();
	const env = {
		HOME: home,
		VP_CLAUDE_CONFIG_DIR: configDir,
		CLAUDE_CONFIG_DIR: "",
		VP_BIN: fakeVpEchoArgs(),
	};
	const submit = runHook(
		script,
		{
			hook_event_name: "UserPromptSubmit",
			prompt: "What is in /tmp/q.png?",
			session_id: "sess-q",
		},
		env,
	);
	assert.equal(submit.status, 0);
	assert.ok(parseOutput(submit), "submit with an image path must emit a reminder");
	const promptCache = join(configDir, "image-cache", "sess-q", "vp-prompt.txt");
	assert.ok(existsSync(promptCache), "submit must stash the prompt for the later PreToolUse");
	assert.equal(
		statSync(promptCache).mode & 0o777,
		0o600,
		"prompt cache must be owner-readable only",
	);
	const transcript = writeTranscript(TRANSCRIPT_LINES, configDir);
	const pre = runHook(
		script,
		{
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/tmp/q.png" },
			session_id: "sess-q",
			transcript_path: transcript,
		},
		env,
	);
	assert.equal(pre.status, 0);
	const out = parseOutput(pre);
	assert.ok(out, "image Read must emit JSON");
	const ctx = out.hookSpecificOutput.additionalContext as string;
	assert.ok(ctx.includes("--prompt-stdin"), "must use secure prompt stdin transport");
	assert.ok(
		ctx.includes('"question":"What is in /tmp/q.png?"'),
		"question must be the stashed prompt",
	);
	assert.ok(
		ctx.includes('"context":"User: what color is it?\\nAssistant:'),
		"context must use stdin transport",
	);
	assert.ok(ctx.includes("User: what color is it?"), "context must carry transcript history");
	assert.ok(ctx.includes("Assistant: It is red."), "context must carry assistant turns");
	assert.ok(!ctx.includes("SHOULD NOT APPEAR"), "context must filter non-user|assistant entries");
	assert.ok(existsSync(promptCache), "prompt cache must survive multiple image reads");
	const again = runHook(
		script,
		{
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/tmp/q.png" },
			session_id: "sess-q",
			transcript_path: transcript,
		},
		env,
	);
	const againCtx = (parseOutput(again)?.hookSpecificOutput.additionalContext ?? "") as string;
	assert.ok(
		againCtx.includes("--prompt-stdin"),
		"the current prompt must apply to every image read",
	);
	assert.ok(againCtx.includes('"question":"What is in /tmp/q.png?"'));
	assert.ok(
		againCtx.includes('"context":"User: what color is it?'),
		"transcript context still applies",
	);
});

test("UserPromptSubmit prompt cache rejects sessionId traversal", () => {
	const home = mkdtempSync(join(tmpdir(), "vp-hook-home-qtraversal-"));
	const configDir = join(home, ".claude");
	const script = writeScript();
	const run = runHook(
		script,
		{
			hook_event_name: "UserPromptSubmit",
			prompt: "What is in /tmp/q.png?",
			session_id: "../evil",
		},
		{
			HOME: home,
			VP_CLAUDE_CONFIG_DIR: configDir,
			CLAUDE_CONFIG_DIR: "",
			VP_BIN: fakeVpEchoArgs(),
		},
	);
	assert.equal(run.status, 0);
	assert.ok(parseOutput(run), "reminder must still be emitted (fail-open)");
	assert.equal(
		existsSync(join(configDir, "image-cache", "evil", "vp-prompt.txt")),
		false,
		"traversal sessionId must not write a prompt cache file",
	);
	assert.equal(existsSync(join(home, "evil")), false);
});

test("empty UserPromptSubmit clears a stale prompt cache", () => {
	const home = mkdtempSync(join(tmpdir(), "vp-hook-home-qclear-"));
	const configDir = join(home, ".claude");
	const script = writeScript();
	const env = { HOME: home, VP_CLAUDE_CONFIG_DIR: configDir, VP_BIN: fakeVpEchoArgs() };
	runHook(
		script,
		{ hook_event_name: "UserPromptSubmit", prompt: "old question", session_id: "sess-clear" },
		env,
	);
	const file = join(configDir, "image-cache", "sess-clear", "vp-prompt.txt");
	assert.ok(existsSync(file));
	runHook(
		script,
		{ hook_event_name: "UserPromptSubmit", prompt: "", session_id: "sess-clear" },
		env,
	);
	assert.equal(existsSync(file), false);
});

test("PreToolUse transcript context fails open on missing, malformed, or empty transcripts", () => {
	const script = writeScript();
	const vp = fakeVpEchoArgs();
	for (const transcript_path of [
		join(tmpdir(), "vp-definitely-absent-transcript.jsonl"),
		writeTranscript(["not json at all", "{bad"]),
		writeTranscript([]),
	]) {
		const run = runHook(
			script,
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: "/tmp/diagram.png" },
				transcript_path,
			},
			{
				VP_BIN: vp,
				VP_CLAUDE_CONFIG_DIR: path.dirname(transcript_path),
			},
		);
		assert.equal(run.status, 0);
		const ctx = (parseOutput(run)?.hookSpecificOutput.additionalContext ?? "") as string;
		assert.ok(ctx.includes("ARGS:analyze"), `analysis must still run for ${transcript_path}`);
		assert.ok(!ctx.includes("--context"), `no --context for ${transcript_path}`);
	}
});

test("PreToolUse rejects transcript paths outside trusted host directories", () => {
	const home = mkdtempSync(join(tmpdir(), "vp-hook-home-transcript-"));
	const transcript = writeTranscript([
		JSON.stringify({ type: "user", message: { role: "user", content: "secret" } }),
	]);
	const run = runHook(
		writeScript(),
		{
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/tmp/diagram.png" },
			transcript_path: transcript,
		},
		{ HOME: home, VP_BIN: fakeVpEchoArgs() },
	);
	const ctx = (parseOutput(run)?.hookSpecificOutput.additionalContext ?? "") as string;
	assert.ok(!ctx.includes("--context"));
	assert.ok(!ctx.includes("secret"));
});

test("PreToolUse omits --context when VP_INCLUDE_CONTEXT=false", () => {
	const script = writeScript();
	const transcript = writeTranscript([
		JSON.stringify({ type: "user", message: { role: "user", content: "history here" } }),
	]);
	const run = runHook(
		script,
		{
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/tmp/diagram.png" },
			transcriptPath: transcript,
		},
		{
			VP_BIN: fakeVpEchoArgs(),
			VP_INCLUDE_CONTEXT: "false",
			VP_CLAUDE_CONFIG_DIR: path.dirname(transcript),
		},
	);
	assert.equal(run.status, 0);
	const ctx = (parseOutput(run)?.hookSpecificOutput.additionalContext ?? "") as string;
	assert.ok(ctx.includes("ARGS:analyze"), "analysis must still run");
	assert.ok(!ctx.includes("--context"), "gate off must omit --context");
});

test("malformed stdin fails open with exit 0 and no stdout", () => {
	const script = writeScript();
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", script],
		{
			input: "not json\n",
			encoding: "utf8",
			timeout: 60000,
		},
	);
	assert.equal(result.status, 0);
	assert.equal(String(result.stdout ?? "").trim(), "");
	assert.ok(existsSync(script), "script file must exist for the check");
});
