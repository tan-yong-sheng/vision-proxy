/**
 * `vp integration` — install/uninstall vision-proxy into an agent.
 *
 * Subcommands:
 *   install <agent>   installs vision-proxy for the agent.
 *                     - pi          writes the generated `analyze_image` extension
 *                                   into Pi's global extensions directory.
 *                     - claude-code writes the UserPromptSubmit shim next to the
 *                                   vp binary and wires it into settings.json.
 *                     - codex       writes the UserPromptSubmit shim next to the
 *                                   vp binary and appends a [[UserPromptSubmit]]
 *                                   block to config.toml.
 *   show <agent>      print what `install` would generate for manual review.
 *   list              show which agents have vision-proxy installed.
 *   status            show installed version markers per agent (flags outdated).
 *   uninstall <agent> removes vision-proxy from the agent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_EXTENSION_SOURCE } from "../pi-extension.ts";
import { VERSION, renderVersionMarker, extractMarkerVersion } from "../version.ts";

const SUPPORTED = ["pi", "claude-code", "codex"];
const PI_EXTENSION_FILENAME = "vision-proxy.ts";
const HOOK_TIMEOUT_SEC = 30;
const HOOK_MARKER = "vision-proxy";

export interface IntegrationResult {
	ok: boolean;
	message: string;
	code: number;
}

interface AgentSpec {
	/** Human-readable name used in messages. */
	id: string;
	/** Where the generated file/shim is installed (abs path). */
	target(opts: { installDir?: string }): string;
	/** Human-readable install location used in messages. */
	locationLabel(opts: { installDir?: string }): string;
	/** Produce the text `install` writes (extension source or shim contents). */
	generate(): string;
	/** Read + return the host config file text (empty string if absent). */
	readConfig(): { raw: string };
	/** Config file edited by install/uninstall (the host's settings/toml). */
	configPath(): string;
	/** Apply the generated file reference to the config; returns new serialized config. */
	apply(targetPath: string, raw: string): string;
	/** Remove our reference from the config; returns new serialized config + whether anything was removed. */
	remove(raw: string): { raw: string; removed: boolean };
	/** Whether the config currently contains our marker. */
	isInstalled(raw: string): boolean;
	/** Hook agents ship a shared.mjs next to the generated shim. */
	sharedShim: boolean;
	/** Version stamped into the generated file, or undefined if unstamped/unknown. */
	installedVersion(opts: { installDir?: string }): string | undefined;
}

function piExtensionsDir(): string {
	return join(homedir(), ".pi", "agent", "extensions");
}

function claudeCodeConfigPath(): string {
	return join(homedir(), ".claude", "settings.json");
}

function codexConfigPath(): string {
	return join(homedir(), ".codex", "config.toml");
}

/** Co-locate the shims with this module (src/shims in dev, dist/shims in build). */
function shimDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "shims"),
		join(here, "..", "src", "shims"),
		join(here, "..", "shims"),
		join(process.cwd(), "src", "shims"),
	];
	for (const c of candidates) {
		if (existsSync(join(c, "claude-code-user-prompt-submit.mjs"))) return c;
	}
	return join(here, "..", "shims");
}

const piSpec: AgentSpec = {
	id: "pi",
	target: ({ installDir }) => join(installDir ?? piExtensionsDir(), PI_EXTENSION_FILENAME),
	locationLabel: ({ installDir }) => join(installDir ?? piExtensionsDir(), PI_EXTENSION_FILENAME),
	generate: () => PI_EXTENSION_SOURCE.replace("__VP_VERSION__PLACEHOLDER__", renderVersionMarker()),
	readConfig: () => ({ raw: "" }),
	configPath: () => "",
	apply: (targetPath) => targetPath,
	remove: (raw) => ({ raw, removed: false }),
	isInstalled: () => existsSync(piSpec.target({})),
	sharedShim: false,
	installedVersion: ({ installDir }) => {
		const path = piSpec.target({ installDir });
		return existsSync(path) ? extractMarkerVersion(readFileSync(path, "utf8")) : undefined;
	},
};

const claudeCode: AgentSpec = {
	id: "claude-code",
	target: ({ installDir }) =>
		join(installDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "shims"), "claude-code-vision-proxy-user-prompt-submit.mjs"),
	locationLabel: ({ installDir }) =>
		join(installDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "shims"), "claude-code-vision-proxy-user-prompt-submit.mjs"),
	generate: () =>
		readFileSync(join(shimDir(), "claude-code-user-prompt-submit.mjs"), "utf8").replace(
			"__VP_VERSION__PLACEHOLDER__",
			renderVersionMarker(),
		),
	readConfig() {
		const p = claudeCodeConfigPath();
		const raw = existsSync(p) ? readFileSync(p, "utf8") : "{}";
		return { raw };
	},
	configPath: claudeCodeConfigPath,
	apply(targetPath, raw) {
		let cfg: Record<string, unknown>;
		try {
			cfg = raw.trim() ? JSON.parse(raw) : {};
		} catch {
			cfg = {};
		}
		if (!cfg.hooks) cfg.hooks = {};
		const hooks = (cfg.hooks as Record<string, unknown>) || {};
		const entry = {
			hooks: [{ type: "command", command: `node ${targetPath}`, timeout: HOOK_TIMEOUT_SEC }],
		};
		const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
		const filtered = (existing as any[]).filter(
			(g) => !JSON.stringify(g).includes(HOOK_MARKER),
		);
		hooks.UserPromptSubmit = [...filtered, entry];
		cfg.hooks = hooks;
		return JSON.stringify(cfg, null, 2);
	},
	remove(raw) {
		let cfg: Record<string, unknown>;
		try {
			cfg = raw.trim() ? JSON.parse(raw) : {};
		} catch {
			cfg = {};
		}
		const hooks = (cfg.hooks as Record<string, unknown>) || {};
		if (!Array.isArray(hooks.UserPromptSubmit)) {
			return { raw, removed: false };
		}
		const filtered = (hooks.UserPromptSubmit as any[]).filter(
			(g) => !JSON.stringify(g).includes(HOOK_MARKER),
		);
		const removed = (hooks.UserPromptSubmit as any[]).length !== filtered.length;
		if (filtered.length === 0) {
			delete hooks.UserPromptSubmit;
		} else {
			hooks.UserPromptSubmit = filtered;
		}
		cfg.hooks = hooks;
		return { raw: JSON.stringify(cfg, null, 2), removed };
	},
	isInstalled(raw) {
		try {
			const cfg = raw.trim() ? JSON.parse(raw) : {};
			const groups = ((cfg.hooks || {}) as any).UserPromptSubmit || [];
			return Array.isArray(groups)
				? groups.some((g: unknown) => JSON.stringify(g).includes(HOOK_MARKER))
				: false;
		} catch {
			return false;
		}
	},
	sharedShim: true,
	installedVersion: ({ installDir }) => {
		const path = claudeCode.target({ installDir });
		return existsSync(path) ? extractMarkerVersion(readFileSync(path, "utf8")) : undefined;
	},
};

const codex: AgentSpec = {
	id: "codex",
	target: ({ installDir }) =>
		join(installDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "shims"), "codex-vision-proxy-user-prompt-submit.mjs"),
	locationLabel: ({ installDir }) =>
		join(installDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "shims"), "codex-vision-proxy-user-prompt-submit.mjs"),
	generate: () =>
		readFileSync(join(shimDir(), "codex-user-prompt-submit.mjs"), "utf8").replace(
			"__VP_VERSION__PLACEHOLDER__",
			renderVersionMarker(),
		),
	readConfig() {
		const p = codexConfigPath();
		const raw = existsSync(p) ? readFileSync(p, "utf8") : "";
		return { raw };
	},
	configPath: codexConfigPath,
	apply(targetPath, raw) {
		if (raw.includes(HOOK_MARKER)) return raw; // already installed
		const block = `\n[[UserPromptSubmit]]\n\n[[UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "node ${targetPath}"\ntimeout = ${HOOK_TIMEOUT_SEC}\nadditionalContextLimit = 4096\n`;
		return raw.trim() ? `${raw.trimEnd()}\n${block}` : block.replace(/^\n/, "");
	},
	remove(raw) {
		if (!raw.includes(HOOK_MARKER)) return { raw, removed: false };
		const blocks = raw.split(/^\[\[UserPromptSubmit\]\]/m);
		const kept = [blocks[0]!];
		let removed = false;
		for (let i = 1; i < blocks.length; i++) {
			if (blocks[i]!.includes(HOOK_MARKER)) {
				removed = true;
				continue;
			}
			kept.push(`[[UserPromptSubmit]]${blocks[i]!}`);
		}
		return {
			raw: kept.join("").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
			removed,
		};
	},
	isInstalled(raw) {
		return raw.includes(HOOK_MARKER);
	},
	sharedShim: true,
	installedVersion: ({ installDir }) => {
		const path = codex.target({ installDir });
		return existsSync(path) ? extractMarkerVersion(readFileSync(path, "utf8")) : undefined;
	},
};

function specFor(agent: string): AgentSpec | undefined {
	if (agent === "pi") return piSpec;
	if (agent === "claude-code") return claudeCode;
	if (agent === "codex") return codex;
	return undefined;
}

function isAgentInstalled(spec: AgentSpec): boolean {
	const target = spec.target({});
	const targetExists = existsSync(target);
	let installed = targetExists;
	// Hook agents are "installed" when their config block is present, even if
	// the shim file lives in a shared install dir we don't manage.
	const cfgPath = spec.configPath();
	if (cfgPath && existsSync(cfgPath)) {
		installed = installed || spec.isInstalled(spec.readConfig().raw);
	}
	return installed;
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
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, spec.generate(), { mode: 0o644 });
	// Hook shims import ./shared.mjs, so it has to land in the same directory.
	if (spec.sharedShim) {
		const sharedSrc = join(shimDir(), "shared.mjs");
		if (existsSync(sharedSrc)) {
			writeFileSync(join(dirname(target), "shared.mjs"), readFileSync(sharedSrc));
		}
	}
	const cfgPath = spec.configPath();
	if (cfgPath) {
		mkdirSync(dirname(cfgPath), { recursive: true });
		const { raw } = spec.readConfig();
		writeFileSync(cfgPath, spec.apply(target, raw));
	}
	return {
		ok: true,
		message: `installed ${agent} integration -> ${spec.locationLabel({ installDir: opts.installDir })}`,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
export async function integrationShow(agent: string): Promise<IntegrationResult> {
	const spec = specFor(agent);
	if (!spec) {
		return {
			ok: false,
			message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
			code: 1,
		};
	}
	return {
		ok: true,
		message: `Generated ${agent} integration (write to ${spec.locationLabel({})}):\n\n${spec.generate()}`,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
export async function integrationList(): Promise<IntegrationResult> {
	const lines: string[] = [];
	for (const agent of SUPPORTED) {
		const spec = specFor(agent)!;
		const installed = isAgentInstalled(spec);
		lines.push(`${installed ? "✓" : " "} ${agent}`);
	}
	return { ok: true, message: lines.join("\n"), code: 0 };
}

/**
 * Report install status per agent, annotated with the vp version embedded in
 * each installed artifact, so the user can see which integrations predate the
 * installed `vp` and should be refreshed with `vp integration install`.
 */
// fallow-ignore-next-line unused-export
export async function integrationStatus(): Promise<IntegrationResult> {
	const lines: string[] = [`vp ${VERSION}`];
	let outdated = 0;
	let installedCount = 0;
	for (const agent of SUPPORTED) {
		const spec = specFor(agent)!;
		const installed = isAgentInstalled(spec);
		if (!installed) {
			lines.push(`✗ ${agent}  not installed`);
			continue;
		}
		installedCount++;
		const marker = spec.installedVersion({});
		if (!marker) {
			lines.push(`✓ ${agent}  installed (version unknown)`);
			outdated++;
			continue;
		}
		if (marker === VERSION) {
			lines.push(`✓ ${agent}  ${marker}`);
		} else {
			lines.push(`! ${agent}  ${marker} (installed vp is ${VERSION}, run: vp integration install ${agent})`);
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
	let removed = false;
	if (cfgPath && existsSync(cfgPath)) {
		const { raw } = spec.readConfig();
		const result = spec.remove(raw);
		writeFileSync(cfgPath, result.raw);
		removed = result.removed;
	} else if (!existsSync(target)) {
		return {
			ok: true,
			message: `nothing to uninstall (${target} absent)`,
			code: 0,
		};
	}
	if (existsSync(target)) {
		try {
			rmSync(target);
		} catch {
			return {
				ok: false,
				message: `failed to remove ${target}`,
				code: 1,
			};
		}
	}
	// Hook agents also ship shared.mjs next to the shim; drop it if now orphaned.
	if (spec.sharedShim) {
		const sharedPath = join(dirname(target), "shared.mjs");
		if (existsSync(sharedPath)) {
			try {
				rmSync(sharedPath);
			} catch {
				/* ignore */
			}
		}
	}
	// If the install dir now holds only the shim + shared.mjs we just removed, clean it up.
	const dir = dirname(target);
	if (existsSync(dir) && readdirSync(dir).length === 0) {
		try {
			rmSync(dir, { recursive: true });
		} catch {
			/* ignore: leave the empty dir if removal fails */
		}
	}
	return {
		ok: true,
		message: removed
			? `uninstalled ${agent} integration (removed ${target})`
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
			return integrationList();
		case "status":
			return integrationStatus();
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
