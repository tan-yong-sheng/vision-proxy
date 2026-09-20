/**
 * Integration lifecycle policy for `vp integration`.
 *
 * Owns the install/show/list/status/uninstall orchestration shared by every
 * host: artifact writes, config registration, empty-dir cleanup, version
 * reporting, and unknown-agent handling. Host-specific facts (paths, generated
 * sources, legacy cleanups) come from `catalog.ts`; the hooks-JSON shape comes
 * from `hooks-config.ts`. The only host-specific display branch is opencode's
 * plugin summary; the Codex TOML cleanup is catalog-owned.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { VERSION } from "../version.ts";
import {
	ARTIFACT_FILENAME,
	legacyArtifactPath,
	legacyArtifactPresent,
	legacyMarkerPath,
	opencodePluginsDir,
	removeLegacyArtifact,
	removeLegacyCodexConfigToml,
	SUPPORTED,
	specFor,
} from "./catalog.ts";
import type { AgentSpec, IntegrationInstallOptions, IntegrationResult } from "./types.ts";

export type { AgentSpec, IntegrationInstallOptions, IntegrationResult };

/**
 * Whether an agent counts as installed: hook agents need their config block
 * present, while Pi/opencode treat the generated file as the install signal.
 */
function isAgentInstalled(spec: AgentSpec, installDir?: string): boolean {
	const cfgPath = spec.configPath();
	// Hook agents are "installed" when their config block is present.
	if (cfgPath) {
		return existsSync(cfgPath) && spec.isInstalled(spec.readConfig().raw);
	}
	// Pi and opencode have no host config; the extension file is the install signal.
	return existsSync(spec.target({ installDir }));
}

function currentCliEntryPoint(): string | undefined {
	const entry = process.argv[1];
	if (!entry || !/\.(?:c?m?js)$/i.test(entry)) return undefined;
	return resolve(entry);
}

function rejectUnknownAgent(agent: string): IntegrationResult {
	return {
		ok: false,
		message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
		code: 1,
	};
}

// fallow-ignore-next-line unused-export
/**
 * Install the generated artifact and register it with the host.
 *
 * @tags integration, lifecycle
 */
export async function integrationInstall(
	agent: string,
	opts: IntegrationInstallOptions = {},
): Promise<IntegrationResult> {
	const spec = specFor(agent);
	if (!spec) return rejectUnknownAgent(agent);
	const target = spec.target({ installDir: opts.installDir });
	const cfgPath = spec.configPath();
	const defaultVpBin = opts.dev ? currentCliEntryPoint() : undefined;
	if (opts.dev && !defaultVpBin) {
		return {
			ok: false,
			message:
				"--dev requires invoking the built JavaScript CLI (for example: node dist/cli.js ...)",
			code: 1,
		};
	}
	if (cfgPath) {
		// Hook agents: write the generated hook script, then register it as a
		// plain `npx tsx` command in the host config. The config carries only
		// standard hook keys; the version marker lives in the script file.
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, spec.generate(defaultVpBin), { mode: 0o644 });
		mkdirSync(dirname(cfgPath), { recursive: true });
		const { raw } = spec.readConfig();
		writeFileSync(cfgPath, spec.apply(raw));
		// Clean up any legacy marker file left by older installs.
		const legacy = legacyMarkerPath(agent);
		if (existsSync(legacy)) {
			try {
				rmSync(legacy);
			} catch {
				/* leave the stale marker if removal fails */
			}
		}
	} else {
		// Pi: the install target is the generated extension file.
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, spec.generate(defaultVpBin), { mode: 0o644 });
	}
	// Codex migrated from config.toml (legacy .mjs shim) to hooks.json; drop the
	// stale TOML block so it can't shadow the new JSON registration.
	if (agent === "codex") removeLegacyCodexConfigToml();
	// Remove the pre-feature-suffix legacy artifact from the same install dir:
	// pi/opencode auto-load every file in their dirs, so a stale legacy file
	// would double-load our hooks on top of the new one.
	removeLegacyArtifact(target);
	return {
		ok: true,
		message: cfgPath
			? `installed ${agent} integration -> ${cfgPath} (hook script: ${target})\nPrerequisite: tsx must be installed for the 'npx tsx' hook command to run (npm install -g tsx).`
			: `installed ${agent} extension -> ${spec.locationLabel({ installDir: opts.installDir })}`,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
/**
 * Print the hook command, generated script source, and merged config for review.
 *
 * @tags integration, lifecycle
 */
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
				`opencode plugin: ${ARTIFACT_FILENAME}\n\nInstall location: ${pluginPath}/\n\n` +
				`The plugin registers hooks for parity with claude-code/codex:\n` +
				`- chat.message -> like UserPromptSubmit (appends a static reminder to read prompt image paths; attached image parts are left untouched)\n` +
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
	let message = "";
	if (command) message += `hook command: ${command}\n\n`;
	if (!cfgPath) {
		message += `extension file (${spec.locationLabel({})}):\n${spec.generate()}\n\n`;
	} else {
		message += `hook script (${spec.locationLabel({})}):\n${spec.generate()}\n\n`;
	}
	message += `${cfgPath || spec.locationLabel({})} (after install):\n${merged}`;
	return {
		ok: true,
		message,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
/**
 * List every supported integration with its installed state (optional
 * installDir overrides the home-relative target).
 *
 * @tags integration, lifecycle
 */
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
 * each installed hook script or Pi/opencode extension marker, so the user can see which
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
			const target = spec.target({ installDir });
			if (legacyArtifactPresent(target)) {
				lines.push(
					`! ${agent}  legacy artifact at ${legacyArtifactPath(target)} - re-run: vp integration install ${agent}`,
				);
			}
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
/**
 * Remove the generated artifact and unregister it from the host config.
 *
 * @tags integration, lifecycle
 */
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
		if (result.removed) writeFileSync(cfgPath, result.raw);
		configRemoved = result.removed;
	} else if (!existsSync(target) && !legacyArtifactPresent(target)) {
		return {
			ok: true,
			message: `nothing to uninstall (${target} absent)`,
			code: 0,
		};
	}
	// `removed` must reflect artifact deletion as well as host-config removal.
	// Agents like `pi` have no host config (configPath() === ""), so the config
	// branch never fires for them; the extension file is the signal. Hook agents
	// remove both the config registration and the generated script.
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
	// Uninstall also clears a legacy-named artifact from the same dir so an
	// auto-loading host (pi/opencode) never resurrects our hooks. This also
	// covers the legacy-only state (new target absent) that skipped the early
	// return above, so uninstalling a pre-migration install cleans up fully.
	const legacyRemoved = removeLegacyArtifact(target);
	const removed = configRemoved || fileDeleted || legacyRemoved;
	// If the install dir now holds only the artifact we just deleted, clean it
	// up. Hook-agent script dirs (~/.claude/hooks, ~/.codex/hooks) are shared
	// with the user's own hooks, so they are left alone.
	if (!cfgPath) {
		const dir = dirname(target);
		if (existsSync(dir) && readdirSync(dir).length === 0) {
			try {
				rmSync(dir, { recursive: true });
			} catch {
				/* leave the empty dir if removal fails */
			}
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

/**
 * CLI dispatch for `vp integration <subcommand> <agent>`.
 *
 * @tags integration, lifecycle
 */
export async function runIntegration(
	sub: string,
	agent: string,
	installDir?: string,
	dev = false,
): Promise<IntegrationResult> {
	switch (sub) {
		case "install":
			if (!agent) return { ok: false, message: "usage: vp integration install <agent>", code: 1 };
			return integrationInstall(agent, { installDir, dev });
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
