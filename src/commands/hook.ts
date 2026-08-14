// fallow-ignore-file unused-file
/**
 * `vp hook` — per-agent UserPromptSubmit shim install tooling.
 *
 * Subcommands:
 *   install <agent>   claude-code | codex   (wires the shim into the agent config)
 *   show <agent>      print the shim + the config block for manual install
 *   list              show installed shims (detected from agent configs)
 *   uninstall <agent> remove the shim from the agent config
 *
 * Agents supported first: claude-code (settings.json) and codex (config.toml).
 * The shims themselves live in `src/shims/*.mjs` and are copied next to the
 * vp binary on install so the agent config references a stable path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED = ["claude-code", "codex"];
const TIMEOUT_SEC = 30;

// shims are co-located with this module: src/shims (dev) or dist/shims (build).
function shimDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "shims"),
		join(here, "..", "src", "shims"),
		join(here, "..", "shims"),
		join(process.cwd(), "src", "shims"),
	];
	for (const c of candidates) {
		// Require an actual shim file so we don't mistake an empty install dir for the source dir.
		if (existsSync(join(c, "claude-code-user-prompt-submit.mjs"))) return c;
	}
	return join(here, "..", "shims");
}

export interface HookResult {
	ok: boolean;
	message: string;
	code: number;
}

interface AgentSpec {
	/** Where the shim is installed (abs path). */
	shimTarget(opts: { installDir: string }): string;
	/** Config file the install edits. */
	configPath(): string;
	/** Produce the JSON/TOML block for `show`. */
	showBlock(shimPath: string): string;
	/** Read + return the config file text. */
	readConfig(): { raw: string };
	/** Apply the shim to the config, returning the new serialized config. */
	apply(shimPath: string, raw: string): string;
	/** Remove the shim from the config, returning the new serialized config. */
	remove(raw: string): { raw: string; removed: boolean };
	/** Whether the config currently contains our shim marker. */
	isInstalled(raw: string): boolean;
}

const MARKER = "vision-proxy";

function claudeCodeConfigPath(): string {
	return join(homedir(), ".claude", "settings.json");
}

function codexConfigPath(): string {
	return join(homedir(), ".codex", "config.toml");
}

const claudeCode: AgentSpec = {
	shimTarget: ({ installDir }) => join(installDir, "claude-code-vision-proxy-user-prompt-submit.mjs"),
	configPath: claudeCodeConfigPath,
	showBlock: (shimPath) =>
		JSON.stringify(
			{
				hooks: {
					UserPromptSubmit: [
						{
							hooks: [
								{
									type: "command",
									command: `node ${shimPath}`,
									timeout: TIMEOUT_SEC,
								},
							],
						},
					],
				},
			},
			null,
			2,
		),
	readConfig() {
		const p = claudeCodeConfigPath();
		const raw = existsSync(p) ? readFileSync(p, "utf8") : "{}";
		return { raw };
	},
	apply(shimPath, raw) {
		let cfg: Record<string, unknown>;
		try {
			cfg = raw.trim() ? JSON.parse(raw) : {};
		} catch {
			cfg = {};
		}
		if (!cfg.hooks) cfg.hooks = {};
		const hooks = (cfg.hooks as Record<string, unknown>) || {};
		const entry = {
			hooks: [{ type: "command", command: `node ${shimPath}`, timeout: TIMEOUT_SEC }],
		};
		// Replace any existing vp entry, then append.
		const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
		const filtered = (existing as any[]).filter(
			(g) => !JSON.stringify(g).includes(MARKER),
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
			(g) => !JSON.stringify(g).includes(MARKER),
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
				? groups.some((g: unknown) => JSON.stringify(g).includes(MARKER))
				: false;
		} catch {
			return false;
		}
	},
};

const codex: AgentSpec = {
	shimTarget: ({ installDir }) => join(installDir, "codex-vision-proxy-user-prompt-submit.mjs"),
	configPath: codexConfigPath,
	showBlock: (shimPath) =>
		`[[UserPromptSubmit]]\n\n[[UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "node ${shimPath}"\ntimeout = ${TIMEOUT_SEC}\nadditionalContextLimit = 4096\n`,
	readConfig() {
		const p = codexConfigPath();
		const raw = existsSync(p) ? readFileSync(p, "utf8") : "";
		return { raw };
	},
	apply(shimPath, raw) {
		if (raw.includes(MARKER)) return raw; // already installed
		const block = `\n[[UserPromptSubmit]]\n\n[[UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "node ${shimPath}"\ntimeout = ${TIMEOUT_SEC}\nadditionalContextLimit = 4096\n`;
		return raw.trim() ? `${raw.trimEnd()}\n${block}` : block.replace(/^\n/, "");
	},
	remove(raw) {
		if (!raw.includes(MARKER)) return { raw, removed: false };
		const blocks = raw.split(/^\[\[UserPromptSubmit\]\]/m);
		const kept = [blocks[0]];
		let removed = false;
		for (let i = 1; i < blocks.length; i++) {
			if (blocks[i]!.includes(MARKER)) {
				removed = true;
				continue;
			}
			kept.push(`[[UserPromptSubmit]]${blocks[i]}`);
		}
		return {
			raw: kept.join("").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
			removed,
		};
	},
	isInstalled(raw) {
		return raw.includes(MARKER);
	},
};

function specFor(agent: string): AgentSpec | undefined {
	if (agent === "claude-code") return claudeCode;
	if (agent === "codex") return codex;
	return undefined;
}

function installDir(): string {
	const script = process.argv[1] ?? fileURLToPath(import.meta.url);
	return join(dirname(script), "shims");
}

// fallow-ignore-next-line unused-export
export async function hookInstall(agent: string): Promise<HookResult> {
	const spec = specFor(agent);
	if (!spec) {
		return {
			ok: false,
			message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
			code: 1,
		};
	}
	const dir = installDir();
	mkdirSync(dir, { recursive: true });
	const shimSrc = join(shimDir(), agent + "-user-prompt-submit.mjs");
	const shimDst = spec.shimTarget({ installDir: dir });
	if (!existsSync(shimSrc)) {
		return { ok: false, message: `shim source not found: ${shimSrc}`, code: 1 };
	}
	mkdirSync(dirname(shimDst), { recursive: true });
	writeFileSync(shimDst, readFileSync(shimSrc), { mode: 0o755 });

	const cfgPath = spec.configPath();
	mkdirSync(dirname(cfgPath), { recursive: true });
	const { raw } = spec.readConfig();
	const next = spec.apply(shimDst, raw);
	writeFileSync(cfgPath, next);
	return {
		ok: true,
		message: `installed ${agent} UserPromptSubmit hook -> ${shimDst}\n  config: ${cfgPath}`,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
export async function hookShow(agent: string): Promise<HookResult> {
	const spec = specFor(agent);
	if (!spec) {
		return {
			ok: false,
			message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
			code: 1,
		};
	}
	const shimPath = join(shimDir(), agent + "-user-prompt-submit.mjs");
	return {
		ok: true,
		message: `Shim: ${shimPath}\n\nConfig block to add:\n\n${spec.showBlock(shimPath)}`,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
export async function hookList(): Promise<HookResult> {
	const lines: string[] = [];
	for (const agent of SUPPORTED) {
		const spec = specFor(agent)!;
		const { raw } = spec.readConfig();
		const installed = spec.isInstalled(raw);
		lines.push(`${installed ? "✓" : " "} ${agent}`);
	}
	return { ok: true, message: lines.join("\n"), code: 0 };
}

// fallow-ignore-next-line unused-export
export async function hookUninstall(agent: string): Promise<HookResult> {
	const spec = specFor(agent);
	if (!spec) {
		return {
			ok: false,
			message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
			code: 1,
		};
	}
	const cfgPath = spec.configPath();
	if (!existsSync(cfgPath)) {
		return { ok: true, message: `nothing to uninstall (${cfgPath} absent)`, code: 0 };
	}
	const { raw } = spec.readConfig();
	const { raw: next, removed } = spec.remove(raw);
	writeFileSync(cfgPath, next);
	const dir = installDir();
	const shimDst = spec.shimTarget({ installDir: dir });
	if (existsSync(shimDst)) {
		try {
			rmSync(shimDst);
		} catch {
			/* ignore */
		}
	}
	return {
		ok: true,
		message: removed
			? `uninstalled ${agent} hook from ${cfgPath}`
			: `${agent} hook was not installed`,
		code: 0,
	};
}

/** CLI dispatch for `vp hook <subcommand> <agent>`. */
export async function runHook(sub: string, agent: string): Promise<HookResult> {
	switch (sub) {
		case "install":
			if (!agent) return { ok: false, message: "usage: vp hook install <agent>", code: 1 };
			return hookInstall(agent);
		case "show":
			if (!agent) return { ok: false, message: "usage: vp hook show <agent>", code: 1 };
			return hookShow(agent);
		case "list":
			return hookList();
		case "uninstall":
			if (!agent) return { ok: false, message: "usage: vp hook uninstall <agent>", code: 1 };
			return hookUninstall(agent);
		default:
			return {
				ok: false,
				message: `unknown hook subcommand "${sub ?? ""}". Try: install, show, list, uninstall`,
				code: 1,
			};
	}
}
