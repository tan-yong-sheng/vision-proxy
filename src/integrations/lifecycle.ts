/**
 * Integration lifecycle policy for `vp integration`.
 *
 * Owns the install/show/list/status/uninstall orchestration shared by every
 * host: artifact writes, config registration, empty-dir cleanup, version
 * reporting, and unknown-agent handling. Host-specific facts (paths, generated
 * sources, legacy cleanups) come from `catalog.ts`; the hooks-JSON shape comes
 * from `hooks-config.ts`. The Codex TOML cleanup is catalog-owned.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractMarkerVersion, VERSION } from "../version.ts";
import {
	canonicalAgentId,
	getLegacyArtifactState,
	legacyArtifactPath,
	legacyArtifactPresent,
	legacyMarkerPath,
	legacyOpencodePluginFiles,
	legacyOpencodePluginsDir,
	removeLegacyArtifact,
	removeLegacyCodexConfigToml,
	SUPPORTED,
	specFor,
} from "./catalog.ts";
import type { AgentSpec, IntegrationInstallOptions, IntegrationResult } from "./types.ts";

export type { AgentSpec, IntegrationInstallOptions, IntegrationResult };

/**
 * The vp binary an installed artifact shells out to, when it is not the
 * default PATH lookup (`"vp"`). A `--dev` install stamps the local CLI
 * entry point here; `integration status` surfaces it so a dev wiring
 * never masquerades as a production install.
 *
 * Control characters (including newlines and ANSI escapes, which JSON
 * decoding would otherwise materialize) are rejected: the value is
 * interpolated into terminal output, so a crafted artifact must not be
 * able to inject status lines or control sequences.
 *
 * @tags integration, lifecycle
 */
export function installedVpBin(target: string): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(target, "utf8");
	} catch {
		return undefined;
	}
	const m = raw.match(/var DEFAULT_VP_BIN = ("(?:[^"\\]|\\.)*");/);
	if (!m) return undefined;
	try {
		const bin = JSON.parse(m[1]!) as unknown;
		if (typeof bin !== "string" || !bin || bin === "vp") return undefined;
		if (hasControlChars(bin)) return undefined;
		return bin;
	} catch {
		return undefined;
	}
}

/**
 * True when a string contains terminal-unsafe control characters (including
 * newlines and ANSI escapes, which JSON decoding would otherwise
 * materialize). Split out so the security check reads without an inline
 * control-character regex literal.
 *
 * @tags integration, lifecycle
 */
function hasControlChars(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/**
 * Whether an agent counts as installed: hook agents need their config block
 * present, while Pi treats the generated file as the install signal.
 */
function isAgentInstalled(spec: AgentSpec, installDir?: string): boolean {
	const cfgPath = spec.configPath();
	// Hook agents are "installed" when their config block is present.
	if (cfgPath) {
		return existsSync(cfgPath) && spec.isInstalled(spec.readConfig().raw);
	}
	// Pi has no host config; the extension file is the install signal.
	return existsSync(spec.target({ installDir }));
}

function currentCliEntryPoint(): string | undefined {
	const entry = process.argv[1];
	if (!entry || !/\.(?:c?m?js)$/i.test(entry)) return undefined;
	return resolve(entry);
}

/** opencode support is paused while its v2 plugin API stabilizes. */
const OPENCODE_PAUSED_MESSAGE =
	"opencode support is paused while its v2 plugin API stabilizes: " +
	"the v1 plugin does not load under v2. Revisit after v2 stabilizes; " +
	"bare `vp analyze` calls under opencode still pick up pending context " +
	"via the OPENCODE marker.";

function rejectUnknownAgent(agent: string): IntegrationResult {
	if (canonicalAgentId(agent) === "opencode") {
		return { ok: false, message: OPENCODE_PAUSED_MESSAGE, code: 1 };
	}
	return {
		ok: false,
		message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")} (deprecated alias: claude-code still accepted)`,
		code: 1,
	};
}

/**
 * Remove orphaned v1 opencode plugin files.
 *
 * opencode has no install spec while its v2 API stabilizes, so this is the
 * only opencode path that acts: it deletes the two exact legacy filenames
 * at the old plugins dir and reports what was removed. With no legacy files present it
 * reports absent instead of failing. The plugins dir itself is shared with
 * the user's own plugins, so it is left in place.
 *
 * @tags integration, lifecycle
 */
async function uninstallLegacyOpencode(installDir?: string): Promise<IntegrationResult> {
	const dir = installDir ?? legacyOpencodePluginsDir();
	let files: string[];
	try {
		files = legacyOpencodePluginFiles(dir);
	} catch {
		return {
			ok: false,
			message: `failed to read ${dir}`,
			code: 1,
		};
	}
	if (files.length === 0) {
		return {
			ok: true,
			message:
				"opencode integration is not installed (nothing to remove; new installs are paused while the v2 plugin API stabilizes)",
			code: 0,
		};
	}
	const removed: string[] = [];
	const failures: string[] = [];
	for (const file of files) {
		try {
			rmSync(file);
			removed.push(file);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") failures.push(file);
		}
	}
	if (failures.length > 0) {
		return {
			ok: false,
			message: `failed to remove ${failures.join(", ")}`,
			code: 1,
		};
	}
	return {
		ok: true,
		message: `uninstalled opencode integration (removed ${removed.join(", ")})`,
		code: 0,
	};
}

/**
 * Resolve the install target and host-config path for an agent.
 *
 * Shared preamble of integrationInstall / integrationUninstall: returns
 * the spec plus its resolved target and config path, or the
 * unknown-agent result when the id is not in the catalog.
 *
 * @tags integration, lifecycle
 */
export function resolveAgentTarget(
	agent: string,
	opts: IntegrationInstallOptions = {},
): { spec: AgentSpec; target: string; cfgPath: string } | { result: IntegrationResult } {
	const spec = specFor(agent);
	if (!spec) return { result: rejectUnknownAgent(agent) };
	return {
		spec,
		target: spec.target({ installDir: opts.installDir }),
		cfgPath: spec.configPath(),
	};
}

// fallow-ignore-next-line unused-export
/**
 * Install the generated artifact and register it with the host.
 *
 * Re-running install overwrites the existing artifact; the result message
 * reports the replaced version when the content differs.
 *
 * @tags integration, lifecycle
 */
export async function integrationInstall(
	agent: string,
	opts: IntegrationInstallOptions = {},
): Promise<IntegrationResult> {
	agent = canonicalAgentId(agent);
	const resolved = resolveAgentTarget(agent, opts);
	if ("result" in resolved) return resolved.result;
	const { spec, target, cfgPath } = resolved;
	const defaultVpBin = opts.dev ? currentCliEntryPoint() : undefined;
	if (opts.dev && !defaultVpBin) {
		return {
			ok: false,
			message:
				"--dev requires invoking the built JavaScript CLI (for example: node dist/cli.js ...)",
			code: 1,
		};
	}
	// Snapshot the installed artifact before overwriting so a reinstall can
	// report what it replaced. Version markers alone cannot catch drift from
	// an unreleased branch (same version, different content), so compare the
	// full generated bytes.
	const nextArtifact = spec.generate(defaultVpBin);
	let prevArtifact: string | undefined;
	try {
		if (existsSync(target)) prevArtifact = readFileSync(target, "utf8");
	} catch {
		prevArtifact = undefined;
	}
	const noun = cfgPath ? "integration" : "extension";
	const where = cfgPath
		? ` -> ${cfgPath} (hook script: ${target})`
		: ` -> ${spec.locationLabel({ installDir: opts.installDir })}`;
	let lead: string;
	if (prevArtifact === undefined) {
		lead = `installed ${agent} ${noun}`;
	} else if (prevArtifact !== nextArtifact) {
		const prevVersion = extractMarkerVersion(prevArtifact) ?? "unversioned artifact";
		lead = `reinstalled ${agent} ${noun} (replaced ${prevVersion} with ${VERSION})`;
	} else {
		lead = `${agent} ${noun} already up to date (${VERSION})`;
	}
	if (cfgPath) {
		// Hook agents: write the generated hook script, then register it as a
		// plain `npx tsx` command in the host config. The config carries only
		// standard hook keys; the version marker lives in the script file.
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, nextArtifact, { mode: 0o644 });
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
		writeFileSync(target, nextArtifact, { mode: 0o644 });
	}
	// Codex migrated from config.toml (legacy .mjs shim) to hooks.json; drop the
	// stale TOML block so it can't shadow the new JSON registration.
	if (agent === "codex") removeLegacyCodexConfigToml();
	// Remove the pre-feature-suffix legacy artifact from the same install dir:
	// Pi auto-loads every file in its dir, so a stale legacy file
	// would double-load our hooks on top of the new one. The tri-state result
	// says directly whether cleanup failed, without a redundant re-probe.
	const legacyCleanup = removeLegacyArtifact(target);
	if (legacyCleanup.state === "survives") {
		const legacyPath = legacyArtifactPath(target);
		if (cfgPath) {
			// Hook-agent configs already point at the freshly written script, so
			// a surviving legacy file is inert; report it, don't fail the install.
			return {
				ok: true,
				message:
					`${lead}${where}\n` +
					`Prerequisite: tsx must be installed for the 'npx tsx' hook command to run (npm install -g tsx).\n` +
					`Warning: legacy artifact at ${legacyPath} could not be removed; it is not executed (the config points at ${target}); delete it manually if desired.`,
				code: 0,
			};
		}
		// The Pi dir auto-loads every file in it: a
		// surviving legacy artifact would double-load our hooks next to the
		// freshly installed one, so fail visibly instead of shipping both.
		return {
			ok: false,
			message: `legacy artifact at ${legacyPath} could not be removed and would double-load ${agent} hooks; delete it manually, then re-run: vp integration install ${agent}`,
			code: 1,
		};
	}
	return {
		ok: true,
		message: cfgPath
			? `${lead}${where}\nPrerequisite: tsx must be installed for the 'npx tsx' hook command to run (npm install -g tsx).`
			: `${lead}${where}`,
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
	agent = canonicalAgentId(agent);
	const spec = specFor(agent);
	if (!spec) return rejectUnknownAgent(agent);

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
 * each installed hook script or Pi extension marker, so the user can see which
 * integrations predate the installed `vp` and should be refreshed with
 * `vp integration install`.
 */
// fallow-ignore-next-line unused-export
export async function integrationStatus(installDir?: string): Promise<IntegrationResult> {
	const lines: string[] = [`vp ${VERSION}`];
	let outdated = 0;
	let installedCount = 0;
	const legacyOpencodeDir = installDir ?? legacyOpencodePluginsDir();
	let legacyOpencodeFiles: string[];
	try {
		legacyOpencodeFiles = legacyOpencodePluginFiles(legacyOpencodeDir);
	} catch {
		return {
			ok: false,
			message: `failed to read ${legacyOpencodeDir}`,
			code: 1,
		};
	}
	if (legacyOpencodeFiles.length > 0) {
		// Orphaned v1 plugin: no spec and no install path, but opencode
		// auto-loads every file in its plugins dir, so a stale file is a
		// live legacy install — count it as installed and out of date.
		// installDir (when set) stands in for the whole home-relative dir.
		// installDir callers inspect a non-default dir, so the remediation
		// names it: the bare command would clean the default dir instead.
		const uninstallHint = installDir
			? `uninstall with the same installDir (${legacyOpencodeDir})`
			: "run: vp integration uninstall opencode";
		for (const file of legacyOpencodeFiles) {
			lines.push(`! opencode  legacy install at ${file} - ${uninstallHint}`);
		}
		// One agent, one count: both filenames present still means a single
		// legacy opencode integration (detail lines above list each file).
		installedCount++;
		outdated++;
	}
	for (const agent of SUPPORTED) {
		const spec = specFor(agent)!;
		const installed = isAgentInstalled(spec, installDir);
		if (!installed) {
			const target = spec.target({ installDir });
			if (legacyArtifactPresent(target)) {
				// Legacy-only integration: the Pi dir auto-loads every file
				// in it, so a surviving stamped legacy artifact is an active
				// pre-migration integration - count it as installed and out of
				// date instead of reporting it "not installed".
				lines.push(
					`! ${agent}  legacy artifact at ${legacyArtifactPath(target)} - re-run: vp integration install ${agent}`,
				);
				installedCount++;
				outdated++;
			} else {
				lines.push(`✗ ${agent}  not installed`);
			}
			continue;
		}
		installedCount++;
		const target = spec.target({ installDir });
		// An agent contributes at most one to `outdated` even when it has
		// both a surviving legacy artifact and a stale/unknown marker.
		let agentOutdated = false;
		if (getLegacyArtifactState(target) === "survives") {
			const legacyPath = legacyArtifactPath(target);
			if (spec.configPath() && spec.installedVersion({ installDir }) !== undefined) {
				// Hook agent with its current script installed: the host config
				// points at it and hook dirs are not auto-scanned, so the
				// surviving legacy file is inert. Note it informationally
				// without counting the agent out of date.
				lines.push(
					`- ${agent}  inert legacy artifact at ${legacyPath} (optional: vp integration install ${agent} or delete it manually)`,
				);
			} else {
				// Legacy is live: a legacy-only registration still executes the
				// legacy file (hook agent), or the Pi dir auto-loads every file so
				// a surviving legacy would double-load pi hooks next to
				// a current one. Re-installing fixes both states.
				lines.push(
					`! ${agent}  legacy artifact at ${legacyPath} - re-run: vp integration install ${agent}`,
				);
				agentOutdated = true;
			}
		}
		const marker = spec.installedVersion({ installDir });
		if (!marker) {
			lines.push(`✓ ${agent}  installed (version unknown)`);
			agentOutdated = true;
		} else if (marker !== VERSION) {
			lines.push(
				`! ${agent}  ${marker} (installed vp is ${VERSION}, run: vp integration install ${agent})`,
			);
			agentOutdated = true;
		} else {
			const devBin = installedVpBin(target);
			lines.push(`✓ ${agent}  ${marker}${devBin ? ` (dev: ${devBin})` : ""}`);
		}
		if (agentOutdated) outdated++;
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
	agent = canonicalAgentId(agent);
	// opencode has no install spec while its v2 API stabilizes: the only
	// uninstall action is removing orphaned v1 plugin files. Install keeps
	// reporting the pause message.
	if (agent === "opencode") return uninstallLegacyOpencode(opts.installDir);
	const resolved = resolveAgentTarget(agent, opts);
	if ("result" in resolved) return resolved.result;
	const { spec, target, cfgPath } = resolved;
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
	// auto-loading host (pi) never resurrects our hooks. This also
	// covers the legacy-only state (new target absent) that skipped the early
	// return above, so uninstalling a pre-migration install cleans up fully.
	const legacyCleanup = removeLegacyArtifact(target);
	// Mirror the install path: the tri-state result says directly whether a
	// stamped legacy file survived the cleanup attempt. A surviving one on an
	// auto-loading host (pi, no cfgPath) would keep double-loading
	// our hooks after uninstall, so fail visibly instead of reporting
	// success; hook agents only get a warning because their config no longer
	// references any script (the leftover is inert).
	if (legacyCleanup.state === "survives") {
		const legacyPath = legacyArtifactPath(target);
		if (!cfgPath) {
			return {
				ok: false,
				message: `legacy artifact at ${legacyPath} could not be removed and would double-load ${agent} hooks; delete it manually, then re-run: vp integration uninstall ${agent}`,
				code: 1,
			};
		}
		return {
			ok: true,
			message:
				`${configRemoved || fileDeleted || legacyCleanup.removed ? `uninstalled ${agent} integration` : `${agent} integration was not installed`}\n` +
				`Warning: legacy artifact at ${legacyPath} could not be removed; it is inert (the config no longer references it) and can be deleted manually.`,
			code: 0,
		};
	}
	const removed = configRemoved || fileDeleted || legacyCleanup.removed;
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
 * Remove every known integration (SUPPORTED agents plus the orphaned v1
 * opencode plugin files).
 *
 * Runs each per-agent uninstall to completion even when one fails, so a
 * `codex` failure never strands a `pi` install. Output is one line per
 * agent (`<agent>: <single-line outcome>`); the exit code is 1 when any
 * agent failed. Multi-line per-agent messages are flattened so the
 * one-line-per-agent shape holds.
 *
 * @tags integration, lifecycle
 */
// fallow-ignore-next-line unused-export
export async function integrationUninstallAll(installDir?: string): Promise<IntegrationResult> {
	const lines: string[] = [];
	let failed = false;
	for (const agent of [...SUPPORTED, "opencode"]) {
		const r = await integrationUninstall(agent, { installDir });
		if (!r.ok) failed = true;
		lines.push(`${agent}: ${r.message.split("\n").join(" ")}`);
	}
	return { ok: !failed, message: lines.join("\n"), code: failed ? 1 : 0 };
}

/**
 * CLI dispatch for `vp integration <subcommand> [<agent>] [--all]`.
 *
 * @tags integration, lifecycle
 */
export async function runIntegration(
	sub: string,
	agent: string,
	installDir?: string,
	dev = false,
	all = false,
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
			if (all) {
				if (agent)
					return {
						ok: false,
						message: "usage: vp integration uninstall <agent> | --all",
						code: 1,
					};
				return integrationUninstallAll(installDir);
			}
			if (!agent)
				return { ok: false, message: "usage: vp integration uninstall <agent> | --all", code: 1 };
			return integrationUninstall(agent, { installDir });
		default:
			return {
				ok: false,
				message: `unknown integration subcommand "${sub ?? ""}". Try: install, show, list, status, uninstall`,
				code: 1,
			};
	}
}
