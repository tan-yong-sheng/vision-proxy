/**
 * Host catalog for `vp integration`.
 *
 * Owns every host-specific fact the lifecycle needs: where each agent's
 * artifact and config live, what file content to generate (version marker +
 * standalone source), the hook command written into host configs, and the
 * legacy cleanups that predate the current installer. Pure path/config
 * translation lives here; filesystem orchestration lives in `lifecycle.ts`;
 * the shared hooks-JSON shape lives in `hooks-config.ts`.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { extractMarkerVersion, renderVersionMarker } from "../version.ts";
import { HOOK_SCRIPT_SOURCE } from "./hook-script.ts";
import { applyHooks, hooksInstalled, removeHooks } from "./hooks-config.ts";
import { PI_EXTENSION_SOURCE } from "./pi-extension.ts";
import type { AgentSpec } from "./types.ts";

/** Every agent `vp integration` knows how to install.
 * opencode was removed while its v2 plugin API stabilizes: the v1 plugin
 * this repo shipped does not load under v2 (SchemaError on V1-style
 * exports), and developing against both APIs at once is churn. Revisit
 * once v2 stabilizes; see docs/INTEGRATIONS.md. */
export const SUPPORTED = ["pi", "claude", "codex"];

/** Deprecated input aliases for agent ids (canonical ids stay unchanged in
 * output, status, and messages). `claude-code` is the pre-rename id for
 * the Claude agent; it still resolves so existing scripts keep working. */
export const AGENT_ALIASES: Record<string, string> = {
	"claude-code": "claude",
};

/**
 * Resolve an agent id through the alias table to its canonical id.
 * Unknown ids pass through unchanged so callers still reject them.
 *
 * @tags integration, catalog
 */
export function canonicalAgentId(agent: string): string {
	return Object.hasOwn(AGENT_ALIASES, agent) ? AGENT_ALIASES[agent]! : agent;
}

/** Installed host artifact name (feature-suffix convention: the Read-time analyze hooks). */
export const ARTIFACT_FILENAME = "vision-proxy_read.ts";
const PI_EXTENSION_FILENAME = ARTIFACT_FILENAME;
const CLAUDE_HOOK_FILENAME = ARTIFACT_FILENAME;
const CODEX_HOOK_FILENAME = ARTIFACT_FILENAME;

/** Legacy artifact name used before the feature-suffix naming. */
export const LEGACY_ARTIFACT_FILENAME = "vision-proxy.ts";

/**
 * Returns the home directory, respecting process.env.HOME for test isolation.
 *
 * @tags integration, catalog
 */
export function getHomeDir(): string {
	// Use an empty-string fallback so HOME="" (common in some CI/sandbox
	// environments) falls through to the real home directory instead of
	// building relative paths such as ".claude/...".
	return process.env.HOME || homedir();
}

/** Pi's global extensions directory (`~/.pi/agent/extensions`). */
export function piExtensionsDir(): string {
	return join(getHomeDir(), ".pi", "agent", "extensions");
}

/** Claude Code's hooks config path (`~/.claude/settings.json`). */
export function claudeCodeConfigPath(): string {
	return join(getHomeDir(), ".claude", "settings.json");
}

/** Codex's hooks config path (`~/.codex/hooks.json`). */
export function codexConfigPath(): string {
	return join(getHomeDir(), ".codex", "hooks.json");
}

/**
 * Absolute path to the generated Claude Code hook script.
 *
 * @tags integration, catalog
 */
export function claudeHookScriptPath(): string {
	return join(getHomeDir(), ".claude", "hooks", CLAUDE_HOOK_FILENAME);
}

/**
 * Absolute path to the generated Codex hook script.
 *
 * @tags integration, catalog
 */
export function codexHookScriptPath(): string {
	return join(getHomeDir(), ".codex", "hooks", CODEX_HOOK_FILENAME);
}

/** Legacy marker file left by older installs (version used to live outside the config). */
export function legacyMarkerPath(agent: string): string {
	return join(getHomeDir(), agent === "codex" ? ".codex" : ".claude", "vision-proxy.hook.json");
}

/**
 * Quote a path for shell use.
 *
 * POSIX shells get single quotes with embedded single quotes escaped
 * (`'\''`), so spaces, `$`, backticks, `!`, and other metacharacters cannot
 * expand or inject. Double quotes are deliberately avoided there: they still
 * allow `$`, backtick, and `!` expansion.
 *
 * On Windows the host runs the command through `cmd.exe`, where single
 * quotes are literal characters — so Windows keeps double-quote grouping
 * (with embedded double quotes doubled), and backslash joins the safe set.
 *
 * The install-time platform is the hook-execution platform (same machine),
 * so the default is correct at runtime; the override exists so tests can
 * cover both branches.
 *
 * @tags integration, catalog
 */
export function quotePath(p: string, platform: string = process.platform): string {
	if (platform === "win32") {
		if (p === "") return '""';
		if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(p)) return p;
		return `"${p.replace(/"/g, '""')}"`;
	}
	if (p === "") return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p)) return p;
	return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * The hook command written into every agent config: `npx tsx <script>`.
 *
 * @tags integration, catalog
 */
export function makeTsHookCommand(scriptPath: string, platform: string = process.platform): string {
	return `npx tsx ${quotePath(scriptPath, platform)}`;
}

/**
 * Render the hook script source with the current version marker embedded.
 *
 * Codex names view_image (its official image tool) in the submit-time
 * reminder; Claude Code and every other caller keep Read.
 *
 * @tags integration, catalog
 */
export function generateHookScript(defaultVpBin?: string, submitToolWord = "Read"): string {
	return renderGeneratedSource(
		stampSubmitToolWord(HOOK_SCRIPT_SOURCE, submitToolWord),
		defaultVpBin,
	);
}

/**
 * Stamp the submit-time tool word into a hook script source.
 *
 * The UserPromptSubmit reminder names the host's native image tool so the
 * model reaches for the tool PreToolUse actually intercepts. Only "Read"
 * and "view_image" are honored; anything else falls back to "Read" so a
 * bad caller cannot inject arbitrary reminder text into the artifact.
 *
 * @tags integration, catalog
 */
export function stampSubmitToolWord(source: string, toolWord: string): string {
	const word = toolWord === "view_image" ? "view_image" : "Read";
	return source.replace(
		'var SUBMIT_TOOL_WORD = "Read";',
		`var SUBMIT_TOOL_WORD = ${JSON.stringify(word)};`,
	);
}

/**
 * Render the Pi extension source with the current version marker embedded.
 *
 * @tags integration, catalog
 */
export function generatePiExtension(defaultVpBin?: string): string {
	return renderGeneratedSource(PI_EXTENSION_SOURCE, defaultVpBin);
}

/**
 * Remove a legacy Codex `[[UserPromptSubmit]]` block from `~/.codex/config.toml`.
 *
 * Older installs appended a TOML block pointing at the removed `.mjs` shim. The
 * installer uses `~/.codex/hooks.json`; this cleans up the stale block on
 * both install and uninstall so a fresh hooks.json isn't shadowed by it.
 *
 * @tags integration, catalog
 */
function renderGeneratedSource(source: string, defaultVpBin?: string): string {
	const withVersion = source.replace("__VP_VERSION__PLACEHOLDER__", renderVersionMarker());
	if (!defaultVpBin) return withVersion;
	return withVersion.replace(
		'var DEFAULT_VP_BIN = "vp";',
		`var DEFAULT_VP_BIN = ${JSON.stringify(defaultVpBin)};`,
	);
}

export function removeLegacyCodexConfigToml(): void {
	const p = join(getHomeDir(), ".codex", "config.toml");
	if (!existsSync(p)) return;
	const raw = readFileSync(p, "utf8");
	if (!raw.includes("vision-proxy")) return;
	const blocks = raw.split(/^\[\[UserPromptSubmit\]\]/m);
	const kept = [blocks[0]!];
	let removed = false;
	for (let i = 1; i < blocks.length; i++) {
		if (blocks[i]!.includes("vision-proxy")) {
			removed = true;
			continue;
		}
		kept.push(`[[UserPromptSubmit]]${blocks[i]!}`);
	}
	if (!removed) return;
	writeFileSync(
		p,
		`${kept
			.join("")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd()}\n`,
	);
}

const piSpec: AgentSpec = {
	id: "pi",
	target: ({ installDir }) => join(installDir ?? piExtensionsDir(), PI_EXTENSION_FILENAME),
	locationLabel: ({ installDir }) => join(installDir ?? piExtensionsDir(), PI_EXTENSION_FILENAME),
	generate: generatePiExtension,
	readConfig: () => ({ raw: "" }),
	configPath: () => "",
	hookCommand: () => "",
	apply: (raw) => raw,
	remove: (raw) => ({ raw, removed: false }),
	isInstalled: () => existsSync(piSpec.target({})),
	installedVersion: ({ installDir }) => {
		const path = piSpec.target({ installDir });
		if (!existsSync(path)) return undefined;
		try {
			return extractMarkerVersion(readFileSync(path, "utf8"));
		} catch {
			return undefined;
		}
	},
};

/**
 * Build a hook-agent spec (Claude Code, Codex): a generated `npx tsx` script
 * plus a shared-shape JSON hooks config carrying only standard keys.
 */
function makeHookAgentSpec(opts: {
	id: string;
	scriptPath: () => string;
	configPath: () => string;
	/** Tool word named by the UserPromptSubmit reminder (defaults to Read). */
	submitToolWord?: string;
}): AgentSpec {
	return {
		id: opts.id,
		target: () => opts.scriptPath(),
		locationLabel: () => opts.scriptPath(),
		generate: (defaultVpBin?: string) => generateHookScript(defaultVpBin, opts.submitToolWord),
		readConfig() {
			const p = opts.configPath();
			const raw = existsSync(p) ? readFileSync(p, "utf8") : "{}";
			return { raw };
		},
		configPath: opts.configPath,
		hookCommand: () => makeTsHookCommand(opts.scriptPath()),
		apply: (raw) =>
			applyHooks(
				raw,
				makeTsHookCommand(opts.scriptPath()),
				opts.id === "codex" ? ["Read", "view_image", "Bash"] : ["Read", "Bash"],
			),
		remove: (raw) => removeHooks(raw),
		isInstalled: (raw?: string) => hooksInstalled(raw ?? ""),
		installedVersion: () => {
			// Hook agents stamp their version into the generated script file;
			// the host config carries only standard hook keys.
			const p = opts.scriptPath();
			if (!existsSync(p)) return undefined;
			try {
				return extractMarkerVersion(readFileSync(p, "utf8"));
			} catch {
				return undefined;
			}
		},
	};
}

const claudeCode: AgentSpec = makeHookAgentSpec({
	id: "claude",
	scriptPath: claudeHookScriptPath,
	configPath: claudeCodeConfigPath,
});

const codex: AgentSpec = makeHookAgentSpec({
	id: "codex",
	scriptPath: codexHookScriptPath,
	configPath: codexConfigPath,
	submitToolWord: "view_image",
});

/** Path of the legacy-named artifact in the directory containing `target`. */
export function legacyArtifactPath(target: string): string {
	return join(dirname(target), LEGACY_ARTIFACT_FILENAME);
}

/**
 * Observable state of the legacy artifact next to `target`.
 *
 * - "survives": a marker-stamped generated legacy file is present
 *   (cleanups failed or have not run yet).
 * - "unknown": a legacy file is present but carries no version marker
 *   (user-authored or unverifiable) - never reported or removed.
 * - "clean": no legacy artifact to worry about.
 *
 * @tags integration, catalog
 */
export type LegacyArtifactState = "clean" | "unknown" | "survives";

/**
 * Probe the legacy artifact next to `target` without removing anything.
 * Only marker-stamped files we generated count as "survives"; the marker
 * gate is what protects user-authored files and the shared hook dirs
 * (claude/codex).
 *
 * @tags integration, catalog
 */
export function getLegacyArtifactState(target: string): LegacyArtifactState {
	const legacy = legacyArtifactPath(target);
	if (!existsSync(legacy)) return "clean";
	try {
		return extractMarkerVersion(readFileSync(legacy, "utf8")) !== undefined
			? "survives"
			: "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Whether a generated (marker-stamped) legacy artifact exists in the
 * directory containing `target`. Unstamped files are user-authored and are
 * never reported or removed.
 *
 * @tags integration, catalog
 */
export function legacyArtifactPresent(target: string): boolean {
	return getLegacyArtifactState(target) === "survives";
}

/**
 * Result of attempting to remove the legacy artifact next to `target`.
 *
 * @tags integration, catalog
 */
export interface LegacyCleanupResult {
	/** "clean" when no stamped legacy was present or removal succeeded,
	 *  "survives" when a stamped legacy file remains (removal failed),
	 *  "unknown" when an unstamped legacy file was left untouched. */
	state: LegacyArtifactState;
	/** Whether a marker-stamped legacy artifact was removed in this call. */
	removed: boolean;
}

/**
 * Remove the generated legacy artifact next to `target` (the Pi dir
 * auto-loads every file in it, so a stale legacy file would double-load).
 * Only marker-stamped files we generated are ever removed; the marker gate is
 * what protects user-authored files and the shared hook dirs (claude/codex).
 *
 * The silent catch is deliberate: rmSync failures (EACCES, locked files) are
 * swallowed here so install/uninstall never abort on cleanup; callers that
 * must act on a surviving legacy file branch on `state === "survives"`
 * directly instead of re-probing.
 *
 * @tags integration, catalog
 */
export function removeLegacyArtifact(target: string): LegacyCleanupResult {
	const state = getLegacyArtifactState(target);
	if (state !== "survives") return { state, removed: false };
	try {
		rmSync(legacyArtifactPath(target));
		return { state: "clean", removed: true };
	} catch {
		/* leave the stale legacy artifact if removal fails */
		return { state: "survives", removed: false };
	}
}

/**
 * Legacy opencode plugins dir (v1 installs only).
 *
 * opencode support is paused: there is no opencode spec and it is not in
 * SUPPORTED, so this path exists solely so status/uninstall can surface and
 * clean up orphaned v1 installs. Matches the pre-removal layout
 * (commit 85d2a9f^): `join(home, ".config", "opencode", "plugins")`.
 *
 * @tags integration, catalog
 */
export function legacyOpencodePluginsDir(): string {
	return join(getHomeDir(), ".config", "opencode", "plugins");
}

/**
 * Orphaned v1 opencode plugin files in `dir`.
 *
 * Matches exactly the two filenames we ever shipped (`vision-proxy.ts`
 * pre-suffix and `vision-proxy_read.ts`): a prefix match would risk
 * deleting user-authored `vision-proxy-*.ts` plugins that merely share
 * the prefix.
 *
 * @tags integration, catalog
 */
export function legacyOpencodePluginFiles(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (e) {
		// Absent dir means no orphans; any other read error (EACCES,
		// ENOTDIR, …) propagates so status/uninstall never misreport a
		// present-but-unreadable install as clean.
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	return entries
		.filter((name) => name === LEGACY_ARTIFACT_FILENAME || name === ARTIFACT_FILENAME)
		.map((name) => join(dir, name));
}

/**
 * Look up the install adapter for an agent id, or undefined when unknown.
 *
 * Input aliases (see AGENT_ALIASES) resolve to the canonical spec first,
 * so `claude-code` (deprecated) returns the same spec as `claude`.
 *
 * @tags integration, catalog
 */
export function specFor(agent: string): AgentSpec | undefined {
	const id = canonicalAgentId(agent);
	if (id === "pi") return piSpec;
	if (id === "claude") return claudeCode;
	if (id === "codex") return codex;
	return undefined;
}
