/**
 * `vp integration` — install/uninstall vision-proxy into an agent.
 *
 * Subcommands:
 *   install <agent>   installs vision-proxy for the agent.
 *                     - pi          writes the generated lifecycle-event
 *                                   extension (input / before_agent_start /
 *                                   tool_result) into Pi's global extensions
 *                                   directory. No tool is registered.
 *                     - claude-code registers a `UserPromptSubmit` hook and a
 *                                   `PreToolUse Read` hook in settings.json, both
 *                                   invoking the absolute `vp hook` path.
 *                     - codex       registers the same two hooks in hooks.json and
 *                                   removes any legacy config.toml block.
 *   show <agent>      print what `install` would generate for manual review.
 *   list              show which agents have vision-proxy installed.
 *   status            show installed version markers per agent (flags outdated).
 *   uninstall <agent> removes vision-proxy from the agent.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { OPENCODE_PLUGIN_SOURCE } from "../opencode-plugin.ts";
import { PI_EXTENSION_SOURCE } from "../pi-extension.ts";
import { extractMarkerVersion, renderVersionMarker, VERSION } from "../version.ts";

export interface IntegrationResult {
	ok: boolean;
	message: string;
	code: number;
}

interface AgentSpec {
	/** Human-readable name used in messages. */
	id: string;
	/** Where the installed marker file lives (abs path). */
	target(opts: { installDir?: string }): string;
	/** Human-readable install location used in messages. */
	locationLabel(opts: { installDir?: string }): string;
	/** Produce the marker file content (version + absolute vp path). */
	generate(): string;
	/** Read + return the host config file text (empty string if absent). */
	readConfig(): { raw: string };
	/** Config file edited by install/uninstall (the host's settings/hooks json). */
	configPath(): string;
	/** The hook command written into the agent config (absolute `vp hook`). */
	hookCommand(): string;
	/** Apply the hook registrations to the config; returns new serialized config. */
	apply(raw: string): string;
	/** Remove our registrations from the config; returns new serialized config + whether anything was removed. */
	remove(raw: string): { raw: string; removed: boolean };
	/** Whether the config currently contains our hook registrations. */
	isInstalled(raw?: string): boolean;
	/** Version stamped into the marker file, or undefined if absent/unstamped. */
	installedVersion(opts: { installDir?: string }): string | undefined;
}

const SUPPORTED = ["pi", "claude-code", "codex", "opencode"];
const PI_EXTENSION_FILENAME = "vision-proxy.ts";
const HOOK_TIMEOUT_SEC = 30;

/** Returns the home directory, respecting process.env.HOME for test isolation. */
function getHomeDir(): string {
	return process.env.HOME ?? homedir();
}

function piExtensionsDir(): string {
	return join(getHomeDir(), ".pi", "agent", "extensions");
}

function claudeCodeConfigPath(): string {
	return join(getHomeDir(), ".claude", "settings.json");
}

function codexConfigPath(): string {
	return join(getHomeDir(), ".codex", "hooks.json");
}

/**
 * Search `PATH` for an executable named `vp` or `vision-proxy` whose
 * `--version` output matches the running vision-proxy version. This lets a
 * source/build invocation (`node dist/cli.js` / `node src/cli.ts`) install
 * hooks that point at the globally-available `vp` binary instead of the
 * transient script path.
 */
function findVpOnPath(): string | null {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;
	for (const dir of pathEnv.split(delimiter)) {
		for (const name of ["vp", "vision-proxy"]) {
			const candidate = join(dir, name);
			try {
				const out = execFileSync(candidate, ["--version"], {
					encoding: "utf8",
					timeout: 2000,
					stdio: ["ignore", "pipe", "ignore"],
				})
					.trim()
					.split(/\r?\n/)[0];
				if (out === VERSION) return resolve(candidate);
			} catch {
				/* not a matching vp binary */
			}
		}
	}
	return null;
}

/** Absolute path to the `vp` binary, used for the hook command at install time. */
function vpBinPath(): string {
	const invoked = process.argv[1] ?? "";
	const invokedName = basename(invoked);
	// If the user already invoked us as `vp`/`vision-proxy`, record that exact
	// path (which may be a symlink such as `~/.local/bin/vp`).
	if (invokedName === "vp" || invokedName === "vision-proxy") {
		return resolve(invoked);
	}
	// When running from source or a built script, prefer a matching `vp` on
	// PATH so the installed hook survives worktree moves and upgrades.
	const pathVp = findVpOnPath();
	if (pathVp) return pathVp;
	// Last resort: use the script that is currently executing.
	return resolve(invoked || "vp");
}

/** The hook command written into every agent config: `<abs-vp> hook`. */
function makeHookCommand(): string {
	return `${vpBinPath()} hook`;
}

/**
 * Build an agent hook group (one command invocation of `vp hook`).
 *
 * `vpManaged` tags the group so install/status/uninstall can find our
 * registration even if the absolute `vp` path changed after an upgrade. Agents
 * ignore the extra key. `version` lets `vp integration status` detect outdated
 * installs without a separate marker file. `matcher` is only set for
 * `PreToolUse`.
 */
function hookGroup(command: string, matcher?: string): Record<string, unknown> {
	const group: Record<string, unknown> = {
		vpManaged: true,
		version: VERSION,
		hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SEC }],
	};
	if (matcher) group.matcher = matcher;
	return group;
}

function parseConfig(raw: string): Record<string, unknown> {
	try {
		return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Detect stale vision-proxy hook registrations that predate the `vpManaged`
 * tagging scheme (e.g. old `.mjs` shims or earlier binary installs).
 */
function isLegacyVisionProxyGroup(group: Record<string, unknown>): boolean {
	if (group.vpManaged === true) return false;
	const hooks = (group.hooks as Array<{ command?: string }> | undefined) ?? [];
	return hooks.some((h) => {
		if (typeof h.command !== "string") return false;
		const cmd = h.command;
		// Old `.mjs` shims that shipped before the binary-as-hook rewrite.
		if (/\b(claude-code-user-prompt-submit|codex-user-prompt-submit|shared)\.mjs\b/.test(cmd))
			return true;
		// Older binary-as-hook installs that didn't tag groups with vpManaged.
		if (/\b(vp|vision-proxy|cli\.js)\s+hook$/.test(cmd)) return true;
		// Any command explicitly mentioning the vision-proxy package/repository path.
		if (/\bvision-proxy\b/.test(cmd)) return true;
		return false;
	});
}

/** Merge `group` into a hook-event array, replacing any existing vpManaged or legacy match. */
function mergeHookGroup(
	existing: unknown,
	group: Record<string, unknown>,
): Record<string, unknown>[] {
	const list = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
	const matches = (g: Record<string, unknown>) =>
		g.vpManaged === true && (group.matcher ? g.matcher === group.matcher : g.matcher === undefined);
	const without = list.filter((g) => !isLegacyVisionProxyGroup(g) && !matches(g));
	without.push(group);
	return without;
}

/** Drop every vpManaged or legacy vision-proxy group from a hook-event array. */
function stripHookGroups(existing: unknown): {
	groups: Record<string, unknown>[];
	removed: boolean;
} {
	const list = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
	const kept = list.filter((g) => g.vpManaged !== true && !isLegacyVisionProxyGroup(g));
	return { groups: kept, removed: kept.length !== list.length };
}

/**
 * Register both hook types (UserPromptSubmit + PreToolUse Read) into a hooks
 * config object serialized as JSON. Shared by Claude Code (settings.json) and
 * Codex (hooks.json), which use the same shape.
 */
function applyHooks(raw: string, command: string): string {
	const cfg = parseConfig(raw);
	if (!cfg.hooks) cfg.hooks = {};
	const hooks = (cfg.hooks as Record<string, unknown>) || {};
	hooks.UserPromptSubmit = mergeHookGroup(hooks.UserPromptSubmit, hookGroup(command));
	hooks.PreToolUse = mergeHookGroup(hooks.PreToolUse, hookGroup(command, "Read"));
	cfg.hooks = hooks;
	return JSON.stringify(cfg, null, 2);
}

/** Remove both vp hook registrations from a hooks config JSON string. */
function removeHooks(raw: string): { raw: string; removed: boolean } {
	const cfg = parseConfig(raw);
	const hooks = (cfg.hooks as Record<string, unknown>) || {};
	if (!Array.isArray(hooks.UserPromptSubmit) && !Array.isArray(hooks.PreToolUse)) {
		return { raw, removed: false };
	}
	const ups = stripHookGroups(hooks.UserPromptSubmit);
	const pts = stripHookGroups(hooks.PreToolUse);
	const removed = ups.removed || pts.removed;
	if (ups.groups.length === 0) delete hooks.UserPromptSubmit;
	else hooks.UserPromptSubmit = ups.groups;
	if (pts.groups.length === 0) delete hooks.PreToolUse;
	else hooks.PreToolUse = pts.groups;
	if (Object.keys(hooks).length === 0) delete cfg.hooks;
	return { raw: JSON.stringify(cfg, null, 2), removed };
}

/** Whether a hooks config JSON contains any vpManaged registration. */
function hooksInstalled(raw: string): boolean {
	const cfg = parseConfig(raw);
	const hooks = (cfg.hooks as Record<string, unknown>) || {};
	const has = (arr: unknown) =>
		Array.isArray(arr) && (arr as Record<string, unknown>[]).some((g) => g.vpManaged === true);
	return has(hooks.UserPromptSubmit) || has(hooks.PreToolUse);
}

/**
 * Remove a legacy Codex `[[UserPromptSubmit]]` block from `~/.codex/config.toml`.
 *
 * Older installs appended a TOML block pointing at the removed `.mjs` shim. The
 * new installer uses `~/.codex/hooks.json`; this cleans up the stale block on
 * both install and uninstall so a fresh hooks.json isn't shadowed by it.
 */
function removeLegacyCodexConfigToml(): void {
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
	generate: () => PI_EXTENSION_SOURCE.replace("__VP_VERSION__PLACEHOLDER__", renderVersionMarker()),
	readConfig: () => ({ raw: "" }),
	configPath: () => "",
	hookCommand: makeHookCommand,
	apply: (raw) => raw,
	remove: (raw) => ({ raw, removed: false }),
	isInstalled: () => existsSync(piSpec.target({})),
	installedVersion: ({ installDir }) => {
		const path = piSpec.target({ installDir });
		return existsSync(path) ? extractMarkerVersion(readFileSync(path, "utf8")) : undefined;
	},
};

function makeHookAgentSpec(opts: {
	id: string;
	markerPath: () => string;
	configPath: () => string;
}): AgentSpec {
	return {
		id: opts.id,
		target: () => opts.markerPath(),
		locationLabel: () => opts.markerPath(),
		generate: () =>
			JSON.stringify(
				{ version: VERSION, vp: vpBinPath(), updatedAt: new Date().toISOString() },
				null,
				2,
			),
		readConfig() {
			const p = opts.configPath();
			const raw = existsSync(p) ? readFileSync(p, "utf8") : "{}";
			return { raw };
		},
		configPath: opts.configPath,
		hookCommand: makeHookCommand,
		apply: (raw) => applyHooks(raw, makeHookCommand()),
		remove: (raw) => removeHooks(raw),
		isInstalled: (raw?: string) => hooksInstalled(raw ?? ""),
		installedVersion: () => {
			const cfgPath = opts.configPath();
			// Hook agents (claude-code, codex) store their version inside the host
			// hooks config. Pi stores it in the extension marker file.
			if (cfgPath) {
				if (!existsSync(cfgPath)) return undefined;
				try {
					const cfg = parseConfig(readFileSync(cfgPath, "utf8"));
					const hooks = (cfg.hooks as Record<string, unknown>) || {};
					for (const event of ["UserPromptSubmit", "PreToolUse"]) {
						const arr = hooks[event];
						if (!Array.isArray(arr)) continue;
						const group = arr.find(
							(g: Record<string, unknown>) => g.vpManaged === true && typeof g.version === "string",
						);
						if (group) return group.version as string;
					}
				} catch {
					return undefined;
				}
				return undefined;
			}
			const p = opts.markerPath();
			if (!existsSync(p)) return undefined;
			try {
				const m = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
				return m.version;
			} catch {
				return undefined;
			}
		},
	};
}

/** Absolute path to the opencode plugins directory where vision-proxy.ts is installed. */
function opencodePluginsDir(): string {
	return join(getHomeDir(), ".config", "opencode", "plugins");
}

const OPENCODE_PLUGIN_FILENAME = "vision-proxy.ts";

const opencodeSpec: AgentSpec = {
	id: "opencode",
	target: ({ installDir }) => join(installDir ?? opencodePluginsDir(), OPENCODE_PLUGIN_FILENAME),
	locationLabel: ({ installDir }) =>
		join(installDir ?? opencodePluginsDir(), OPENCODE_PLUGIN_FILENAME),
	generate: () =>
		OPENCODE_PLUGIN_SOURCE.replace("__VP_VERSION__PLACEHOLDER__", renderVersionMarker()),
	readConfig: () => ({ raw: "" }),
	configPath: () => "",
	hookCommand: makeHookCommand,
	apply: (raw) => raw,
	remove: (raw) => ({ raw, removed: false }),
	isInstalled: () => existsSync(opencodeSpec.target({})),
	installedVersion: ({ installDir }) => {
		const path = opencodeSpec.target({ installDir });
		return existsSync(path) ? extractMarkerVersion(readFileSync(path, "utf8")) : undefined;
	},
};

const claudeCode: AgentSpec = makeHookAgentSpec({
	id: "claude-code",
	markerPath: () => join(getHomeDir(), ".claude", "vision-proxy.hook.json"),
	configPath: claudeCodeConfigPath,
});

const codex: AgentSpec = makeHookAgentSpec({
	id: "codex",
	markerPath: () => join(getHomeDir(), ".codex", "vision-proxy.hook.json"),
	configPath: codexConfigPath,
});

function specFor(agent: string): AgentSpec | undefined {
	if (agent === "pi") return piSpec;
	if (agent === "opencode") return opencodeSpec;
	if (agent === "claude-code") return claudeCode;
	if (agent === "codex") return codex;
	return undefined;
}

function isAgentInstalled(spec: AgentSpec, installDir?: string): boolean {
	const cfgPath = spec.configPath();
	// Hook agents are "installed" when their config block is present.
	if (cfgPath) {
		return existsSync(cfgPath) && spec.isInstalled(spec.readConfig().raw);
	}
	// Pi and opencode have no host config; the extension file is the install signal.
	return existsSync(spec.target({ installDir }));
}

function rejectUnknownAgent(agent: string): IntegrationResult {
	return {
		ok: false,
		message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
		code: 1,
	};
}

interface IntegrationInstallOptions {
	/** Override the directory where generated files are written (defaults per-agent). */
	installDir?: string;
}

// fallow-ignore-next-line unused-export
export async function integrationInstall(
	agent: string,
	opts: IntegrationInstallOptions = {},
): Promise<IntegrationResult> {
	const spec = specFor(agent);
	if (!spec) return rejectUnknownAgent(agent);
	const target = spec.target({ installDir: opts.installDir });
	const cfgPath = spec.configPath();
	if (cfgPath) {
		// Hook agents: write hooks directly into the host config. No separate
		// marker file is needed because the version is embedded in the hook group.
		mkdirSync(dirname(cfgPath), { recursive: true });
		const { raw } = spec.readConfig();
		writeFileSync(cfgPath, spec.apply(raw));
		// Clean up any legacy marker file left by older installs.
		if (existsSync(target)) {
			try {
				rmSync(target);
			} catch {
				/* leave the stale marker if removal fails */
			}
		}
	} else {
		// Pi: the install target is the generated extension file.
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, spec.generate(), { mode: 0o644 });
	}
	// Codex migrated from config.toml (legacy .mjs shim) to hooks.json; drop the
	// stale TOML block so it can't shadow the new JSON registration.
	if (agent === "codex") removeLegacyCodexConfigToml();
	return {
		ok: true,
		message: cfgPath
			? `installed ${agent} integration -> ${cfgPath}`
			: `installed ${agent} extension -> ${spec.locationLabel({ installDir: opts.installDir })}`,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
/** Print the install target and (for opencode) the generated plugin source, or the hook command and merged config for other agents. */
export async function integrationShow(agent: string): Promise<IntegrationResult> {
	const spec = specFor(agent);
	if (!spec) {
		return {
			ok: false,
			message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
			code: 1,
		};
	}

	// opencode: keep the friendly summary but also render the generated source
	// so the user can review what `vp integration install opencode` writes
	// (mirrors the pi branch below, which appends spec.generate()).
	if (agent === "opencode") {
		const pluginPath = opencodePluginsDir();
		return {
			ok: true,
			message:
				`opencode plugin: vision-proxy.ts\n\nInstall location: ${pluginPath}/\n\n` +
				`The plugin registers hooks for parity with claude-code/codex:\n` +
				`- chat.message -> like UserPromptSubmit (describes prompt paths and attached images, removes the image parts)\n` +
				`- tool.execute.before (read) -> like PreToolUse Read (intercepts reads on images)\n\n` +
				`Configuration via environment variables:\n` +
				`- VP_MAX_OUTPUT_TOKENS (default: 2000)\n` +
				`- VP_BIN (default: vp on PATH)\n` +
				`- VP_HOOK_TIMEOUT_MS (default: 30000)\n\n` +
				`Generated plugin source:\n${spec.generate()}`,
			code: 0,
		};
	}

	const command = spec.hookCommand();
	const { raw } = spec.readConfig();
	const merged = spec.apply(raw);
	const cfgPath = spec.configPath();
	let message = `hook command: ${command}\n\n`;
	if (!cfgPath) {
		message += `extension file (${spec.locationLabel({})}):\n${spec.generate()}\n\n`;
	}
	message += `${cfgPath ?? spec.locationLabel({})} (after install):\n${merged}`;
	return {
		ok: true,
		message,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
/** List every supported integration with its installed/version state (optional installDir overrides the home-relative target). */
export async function integrationList(installDir?: string): Promise<IntegrationResult> {
	const lines: string[] = [];
	for (const agent of SUPPORTED) {
		const spec = specFor(agent)!;
		const installed = isAgentInstalled(spec, installDir);
		lines.push(`${installed ? "✓" : " "} ${agent}`);
	}
	return { ok: true, message: lines.join("\n"), code: 0 };
}

/**
 * Report install status per agent, annotated with the vp version embedded in
 * each installed hook group or Pi/opencode extension marker, so the user can see which
 * integrations predate the installed `vp` and should be refreshed with
 * `vp integration install`.
 */
// fallow-ignore-next-line unused-export
export async function integrationStatus(installDir?: string): Promise<IntegrationResult> {
	const lines: string[] = [`vp ${VERSION}`];
	let outdated = 0;
	let installedCount = 0;
	for (const agent of SUPPORTED) {
		const spec = specFor(agent)!;
		const installed = isAgentInstalled(spec, installDir);
		if (!installed) {
			lines.push(`✗ ${agent}  not installed`);
			continue;
		}
		installedCount++;
		const marker = spec.installedVersion({ installDir });
		if (!marker) {
			lines.push(`✓ ${agent}  installed (version unknown)`);
			outdated++;
			continue;
		}
		if (marker === VERSION) {
			lines.push(`✓ ${agent}  ${marker}`);
		} else {
			lines.push(
				`! ${agent}  ${marker} (installed vp is ${VERSION}, run: vp integration install ${agent})`,
			);
			outdated++;
		}
	}
	lines.push("");
	lines.push(
		installedCount === 0
			? "no integrations installed"
			: outdated === 0
				? `all ${installedCount} integration(s) up to date`
				: `${outdated} of ${installedCount} integration(s) out of date`,
	);
	return { ok: true, message: lines.join("\n"), code: 0 };
}

// fallow-ignore-next-line unused-export
export async function integrationUninstall(
	agent: string,
	opts: IntegrationInstallOptions = {},
): Promise<IntegrationResult> {
	const spec = specFor(agent);
	if (!spec) return rejectUnknownAgent(agent);
	const target = spec.target({ installDir: opts.installDir });
	const cfgPath = spec.configPath();
	let configRemoved = false;
	if (cfgPath && existsSync(cfgPath)) {
		const { raw } = spec.readConfig();
		const result = spec.remove(raw);
		writeFileSync(cfgPath, result.raw);
		configRemoved = result.removed;
	} else if (!existsSync(target)) {
		return {
			ok: true,
			message: `nothing to uninstall (${target} absent)`,
			code: 0,
		};
	}
	// `removed` must reflect marker-file deletion as well as host-config removal.
	// Agents like `pi` have no host config (configPath() === ""), so the config
	// branch never fires for them; the extension file is the signal.
	let fileDeleted = false;
	if (existsSync(target)) {
		try {
			rmSync(target);
			fileDeleted = true;
		} catch {
			return {
				ok: false,
				message: `failed to remove ${target}`,
				code: 1,
			};
		}
	}
	// Remove the legacy Codex config.toml block defensively on uninstall too.
	if (agent === "codex") removeLegacyCodexConfigToml();
	const removed = configRemoved || fileDeleted;
	// If the install dir now holds only the marker we just deleted, clean it up.
	const dir = dirname(target);
	if (existsSync(dir) && readdirSync(dir).length === 0) {
		try {
			rmSync(dir, { recursive: true });
		} catch {
			/* leave the empty dir if removal fails */
		}
	}
	return {
		ok: true,
		message: removed
			? `uninstalled ${agent} integration`
			: `${agent} integration was not installed`,
		code: 0,
	};
}

/** CLI dispatch for `vp integration <subcommand> <agent>`. */
export async function runIntegration(
	sub: string,
	agent: string,
	installDir?: string,
): Promise<IntegrationResult> {
	switch (sub) {
		case "install":
			if (!agent) return { ok: false, message: "usage: vp integration install <agent>", code: 1 };
			return integrationInstall(agent, { installDir });
		case "show":
			if (!agent) return { ok: false, message: "usage: vp integration show <agent>", code: 1 };
			return integrationShow(agent);
		case "list":
			return integrationList(installDir);
		case "status":
			return integrationStatus(installDir);
		case "uninstall":
			if (!agent) return { ok: false, message: "usage: vp integration uninstall <agent>", code: 1 };
			return integrationUninstall(agent, { installDir });
		default:
			return {
				ok: false,
				message: `unknown integration subcommand "${sub ?? ""}". Try: install, show, list, status, uninstall`,
				code: 1,
			};
	}
}
