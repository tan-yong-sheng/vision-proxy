/**
 * Unit tests for the integrations host catalog.
 *
 * Pins the extracted boundary: the supported agent list, per-host spec
 * lookup, generated sources carrying the rendered version marker, hook
 * command quoting, home-relative paths honoring process.env.HOME, and the
 * legacy Codex TOML cleanup staying installer-side.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderVersionMarker, VERSION } from "../version.ts";
import {
	claudeCodeConfigPath,
	claudeHookScriptPath,
	codexConfigPath,
	codexHookScriptPath,
	generateHookScript,
	generateOpencodePlugin,
	generatePiExtension,
	getHomeDir,
	legacyMarkerPath,
	makeTsHookCommand,
	opencodePluginsDir,
	piExtensionsDir,
	quotePath,
	removeLegacyCodexConfigToml,
	SUPPORTED,
	specFor,
} from "./catalog.ts";

const ORIG_HOME = process.env.HOME;

function isolate(): string {
	const home = mkdtempSync(join(tmpdir(), "vp-catalog-test-"));
	process.env.HOME = home;
	return home;
}

function reset() {
	if (ORIG_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIG_HOME;
}

test("SUPPORTED lists the four hosts and specFor resolves each", () => {
	assert.deepEqual(SUPPORTED, ["pi", "claude-code", "codex", "opencode"]);
	for (const agent of SUPPORTED) {
		const spec = specFor(agent);
		assert.ok(spec, `${agent} must resolve a spec`);
		assert.equal(spec!.id, agent);
	}
	assert.equal(specFor("vim"), undefined);
});

test("generated sources embed the rendered version marker", () => {
	const marker = renderVersionMarker();
	assert.ok(marker.includes(VERSION));
	for (const generate of [generateHookScript, generatePiExtension, generateOpencodePlugin]) {
		const source = generate();
		assert.ok(source.includes(marker), "generated source must carry the version marker");
		assert.ok(!source.includes("__VP_VERSION__PLACEHOLDER__"), "placeholder must render away");
	}
});

test("hook command quotes paths with whitespace", () => {
	assert.equal(
		quotePath("/home/u/.claude/hooks/vision-proxy.ts"),
		"/home/u/.claude/hooks/vision-proxy.ts",
	);
	assert.equal(
		quotePath("/home/my user/hooks/vision-proxy.ts"),
		"'/home/my user/hooks/vision-proxy.ts'",
	);
	assert.equal(
		makeTsHookCommand("/home/my user/.claude/hooks/vision-proxy.ts"),
		"npx tsx '/home/my user/.claude/hooks/vision-proxy.ts'",
	);
	assert.equal(makeTsHookCommand("/plain/path.ts"), "npx tsx /plain/path.ts");
});

test("quotePath hardens shell metacharacters with single-quote escaping", () => {
	// `$`, backticks, and `!` must not expand: single quotes, not double.
	assert.equal(quotePath("/home/u/$HOME/x.ts"), "'/home/u/$HOME/x.ts'");
	assert.equal(quotePath("/home/u/`whoami`.ts"), "'/home/u/`whoami`.ts'");
	assert.equal(quotePath("/home/u/don't/x.ts"), "'/home/u/don'\\''t/x.ts'");
	assert.equal(quotePath(""), "''");
});

test("quotePath uses double-quote grouping on win32 (cmd.exe has no single quotes)", () => {
	// Backslash paths stay bare; spaces group with double quotes; embedded
	// double quotes double up. Single quotes would be literal under cmd.exe.
	assert.equal(
		quotePath("C:\\Users\\me\\.claude\\hooks\\vision-proxy.ts", "win32"),
		"C:\\Users\\me\\.claude\\hooks\\vision-proxy.ts",
	);
	assert.equal(
		quotePath("C:\\Users\\my user\\hooks\\vision-proxy.ts", "win32"),
		'"C:\\Users\\my user\\hooks\\vision-proxy.ts"',
	);
	assert.equal(quotePath('C:\\we"ird\\x.ts', "win32"), '"C:\\we""ird\\x.ts"');
	assert.equal(quotePath("", "win32"), '""');
	assert.equal(
		makeTsHookCommand("C:\\Users\\my user\\hooks\\vision-proxy.ts", "win32"),
		'npx tsx "C:\\Users\\my user\\hooks\\vision-proxy.ts"',
	);
});

test("file integration status tolerates a non-file target", () => {
	const home = isolate();
	try {
		const piDir = join(home, "pi");
		const opencodeDir = join(home, "opencode");
		mkdirSync(join(piDir, "vision-proxy.ts"), { recursive: true });
		mkdirSync(join(opencodeDir, "vision-proxy.ts"), { recursive: true });
		assert.equal(specFor("pi")!.installedVersion({ installDir: piDir }), undefined);
		assert.equal(specFor("opencode")!.installedVersion({ installDir: opencodeDir }), undefined);
	} finally {
		reset();
	}
});

test("catalog paths honor process.env.HOME", () => {
	const home = isolate();
	try {
		assert.equal(getHomeDir(), home);
		assert.equal(claudeHookScriptPath(), join(home, ".claude", "hooks", "vision-proxy.ts"));
		assert.equal(codexHookScriptPath(), join(home, ".codex", "hooks", "vision-proxy.ts"));
		assert.equal(claudeCodeConfigPath(), join(home, ".claude", "settings.json"));
		assert.equal(codexConfigPath(), join(home, ".codex", "hooks.json"));
		assert.equal(piExtensionsDir(), join(home, ".pi", "agent", "extensions"));
		assert.equal(opencodePluginsDir(), join(home, ".config", "opencode", "plugins"));
		assert.equal(legacyMarkerPath("claude-code"), join(home, ".claude", "vision-proxy.hook.json"));
		assert.equal(legacyMarkerPath("codex"), join(home, ".codex", "vision-proxy.hook.json"));
	} finally {
		reset();
	}
});

test("hook-agent specs report script paths and metadata-free commands", () => {
	const home = isolate();
	try {
		for (const agent of ["claude-code", "codex"] as const) {
			const spec = specFor(agent)!;
			assert.match(spec.hookCommand(), /^npx tsx /);
			assert.ok(spec.hookCommand().includes("vision-proxy.ts"));
			assert.equal(
				spec.configPath(),
				agent === "claude-code"
					? join(home, ".claude", "settings.json")
					: join(home, ".codex", "hooks.json"),
			);
			// Config registrations carry only standard keys; version lives in the file.
			const merged = JSON.parse(spec.apply("{}"));
			assert.equal("vpManaged" in merged.hooks.UserPromptSubmit[0], false);
			assert.equal("version" in merged.hooks.UserPromptSubmit[0], false);
		}
	} finally {
		reset();
	}
});

test("file-agent specs treat the artifact as the install signal", () => {
	const home = isolate();
	try {
		assert.equal(specFor("pi")!.configPath(), "");
		assert.equal(specFor("opencode")!.configPath(), "");
		assert.equal(specFor("pi")!.hookCommand(), "");
		assert.equal(specFor("opencode")!.hookCommand(), "");
		assert.ok(specFor("pi")!.target({}).startsWith(home));
		assert.ok(specFor("opencode")!.target({}).startsWith(home));
	} finally {
		reset();
	}
});

test("removeLegacyCodexConfigToml drops only vision-proxy blocks", () => {
	const home = isolate();
	try {
		// Absent file is a no-op.
		removeLegacyCodexConfigToml();
		mkdirSync(join(home, ".codex"), { recursive: true });
		const tomlPath = join(home, ".codex", "config.toml");
		// File without vision-proxy is untouched.
		writeFileSync(tomlPath, '# plain\n[other]\nkey = "value"\n');
		removeLegacyCodexConfigToml();
		assert.equal(readFileSync(tomlPath, "utf8").includes("[other]"), true);

		writeFileSync(
			tomlPath,
			'[other]\nkey = "value"\n[[UserPromptSubmit]]\ncommand = "node /old/vision-proxy.mjs"\n[[UserPromptSubmit]]\ncommand = "other-hook"\n',
		);
		removeLegacyCodexConfigToml();
		const cleaned = readFileSync(tomlPath, "utf8");
		assert.equal(cleaned.includes("vision-proxy"), false);
		assert.ok(cleaned.includes("other-hook"), "foreign block must survive");
		assert.equal(existsSync(tomlPath), true);
	} finally {
		reset();
	}
});
