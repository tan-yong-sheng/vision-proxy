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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOOK_SCRIPT_SOURCE } from "../hook-script.ts";
import { OPENCODE_PLUGIN_SOURCE } from "../opencode-plugin.ts";
import { PI_EXTENSION_SOURCE } from "../pi-extension.ts";
import { extractMarkerVersion, renderVersionMarker } from "../version.ts";
import { applyHooks, hooksInstalled, removeHooks } from "./hooks-config.ts";
import type { AgentSpec } from "./types.ts";

/** Every agent `vp integration` knows how to install. */
export const SUPPORTED = ["pi", "claude-code", "codex", "opencode"];

const PI_EXTENSION_FILENAME = "vision-proxy.ts";
const CLAUDE_HOOK_FILENAME = "vision-proxy.ts";
const CODEX_HOOK_FILENAME = "vision-proxy.ts";
const OPENCODE_PLUGIN_FILENAME = "vision-proxy.ts";

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

/** Absolute path to the opencode plugins directory. */
export function opencodePluginsDir(): string {
	return join(getHomeDir(), ".config", "opencode", "plugins");
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
 * @tags integration, catalog
 */
export function generateHookScript(defaultVpBin?: string): string {
	return renderGeneratedSource(HOOK_SCRIPT_SOURCE, defaultVpBin);
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
 * Render the opencode plugin source with the current version marker embedded.
 *
 * @tags integration, catalog
 */
export function generateOpencodePlugin(defaultVpBin?: string): string {
	return renderGeneratedSource(OPENCODE_PLUGIN_SOURCE, defaultVpBin);
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
}): AgentSpec {
	return {
		id: opts.id,
		target: () => opts.scriptPath(),
		locationLabel: () => opts.scriptPath(),
		generate: generateHookScript,
		readConfig() {
			const p = opts.configPath();
			const raw = existsSync(p) ? readFileSync(p, "utf8") : "{}";
			return { raw };
		},
		configPath: opts.configPath,
		hookCommand: () => makeTsHookCommand(opts.scriptPath()),
		apply: (raw) => applyHooks(raw, makeTsHookCommand(opts.scriptPath())),
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

const opencodeSpec: AgentSpec = {
	id: "opencode",
	target: ({ installDir }) => join(installDir ?? opencodePluginsDir(), OPENCODE_PLUGIN_FILENAME),
	locationLabel: ({ installDir }) =>
		join(installDir ?? opencodePluginsDir(), OPENCODE_PLUGIN_FILENAME),
	generate: generateOpencodePlugin,
	readConfig: () => ({ raw: "" }),
	configPath: () => "",
	hookCommand: () => "",
	apply: (raw) => raw,
	remove: (raw) => ({ raw, removed: false }),
	isInstalled: () => existsSync(opencodeSpec.target({})),
	installedVersion: ({ installDir }) => {
		const path = opencodeSpec.target({ installDir });
		if (!existsSync(path)) return undefined;
		try {
			return extractMarkerVersion(readFileSync(path, "utf8"));
		} catch {
			return undefined;
		}
	},
};

const claudeCode: AgentSpec = makeHookAgentSpec({
	id: "claude-code",
	scriptPath: claudeHookScriptPath,
	configPath: claudeCodeConfigPath,
});

const codex: AgentSpec = makeHookAgentSpec({
	id: "codex",
	scriptPath: codexHookScriptPath,
	configPath: codexConfigPath,
});

/**
 * Look up the install adapter for an agent id, or undefined when unknown.
 *
 * @tags integration, catalog
 */
export function specFor(agent: string): AgentSpec | undefined {
	if (agent === "pi") return piSpec;
	if (agent === "opencode") return opencodeSpec;
	if (agent === "claude-code") return claudeCode;
	if (agent === "codex") return codex;
	return undefined;
}
