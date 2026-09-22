/**
 * `vp doctor` — offline environment diagnostics.
 *
 * Answers "is my environment sane?" without any network I/O (live probing
 * stays in `vp provider test`). Every check reuses existing code paths; WARN
 * never fails the command, any FAIL exits 1.
 */
import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cacheStats, configureCache } from "../cache.ts";
import { loadConfig } from "../config.ts";
import { integrationStatus } from "../integrations/index.ts";
import { keyringAvailable } from "../keyring.ts";
import { listProviders } from "../provider.ts";
import { providerCheck } from "./provider.ts";

export type DoctorSeverity = "OK" | "WARN" | "FAIL";

export interface DoctorCheck {
	name: string;
	severity: DoctorSeverity;
	detail: string;
}

export interface DoctorResult {
	ok: boolean;
	message: string;
	code: number;
	checks: DoctorCheck[];
}

export interface DoctorOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	json?: boolean;
	deps?: DoctorDeps;
}

export interface DoctorDeps {
	nodeVersion?: string;
	requiredEngines?: string;
	/** Injectable sharp probe: import + 1px decode via the sniff path. */
	probeSharp?: () => Promise<void>;
	cacheWritable?: (dir: string) => Promise<{ writable: boolean; detail?: string }>;
	integrationStatusText?: () => Promise<string>;
	distPresent?: () => boolean;
}

function line(c: DoctorCheck): string {
	return `${c.severity}  ${c.name}: ${c.detail}`;
}

function parseRequiredMajor(engines: string): number | undefined {
	const m = engines.match(/(\d+)\.(\d+)\.(\d+)/);
	return m ? Number(m[1]) : undefined;
}

function parseNodeMajor(version: string): number | undefined {
	const m = version.match(/^v?(\d+)\./);
	return m ? Number(m[1]) : undefined;
}

async function defaultProbeSharp(): Promise<void> {
	const sharp = (await import("sharp")).default;
	const pixel = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);
	const meta = await sharp(pixel).metadata();
	if (!meta.mediaType || !/^image\//.test(meta.mediaType)) {
		throw new Error("sharp decoded the probe pixel without an image media type");
	}
}

async function defaultCacheWritable(dir: string): Promise<{ writable: boolean; detail?: string }> {
	try {
		await access(dir, constants.W_OK);
		return { writable: true };
	} catch {
		try {
			await import("node:fs/promises").then((fs) =>
				fs.mkdir(dir, { recursive: true, mode: 0o700 }),
			);
			await access(dir, constants.W_OK);
			return { writable: true };
		} catch (err) {
			return {
				writable: false,
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}
}

/**
 * Run the offline diagnostics suite.
 *
 * Checks are ordered runtime → config → cache → keyring → integrations →
 * build so the first FAIL usually explains later ones.
 */
export async function doctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();
	const deps = opts.deps ?? {};
	const checks: DoctorCheck[] = [];

	// 1. Node version vs engines.
	const nodeVersion = deps.nodeVersion ?? process.version;
	const engines = deps.requiredEngines ?? (await readEnginesRequirement().catch(() => ">=22.6.0"));
	const requiredMajor = parseRequiredMajor(engines);
	const actualMajor = parseNodeMajor(nodeVersion);
	if (requiredMajor !== undefined && actualMajor !== undefined && actualMajor < requiredMajor) {
		checks.push({
			name: "node",
			severity: "FAIL",
			detail: `${nodeVersion} is below required ${engines}`,
		});
	} else {
		checks.push({ name: "node", severity: "OK", detail: `${nodeVersion} satisfies ${engines}` });
	}

	// 2. sharp native binding: import + 1px decode.
	try {
		await (deps.probeSharp ?? defaultProbeSharp)();
		checks.push({ name: "sharp", severity: "OK", detail: "native binding decodes PNG" });
	} catch (err) {
		checks.push({
			name: "sharp",
			severity: "FAIL",
			detail: `broken native binding: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	// 3. Config resolves and the provider is known.
	let providerId = "";
	let configApiKey = "";
	let configProvider = "";
	try {
		const { config, resolvedFrom } = await loadConfig({ cwd, env });
		providerId = config.provider;
		configApiKey = config.apiKey;
		configProvider = config.provider;
		if (!listProviders().some((p) => p.id === config.provider)) {
			checks.push({
				name: "config",
				severity: "FAIL",
				detail: `unknown provider "${config.provider}" (${resolvedFrom})`,
			});
		} else {
			checks.push({
				name: "config",
				severity: "OK",
				detail: `resolves (${resolvedFrom}), provider "${config.provider}" known`,
			});
		}
	} catch (err) {
		checks.push({
			name: "config",
			severity: "FAIL",
			detail: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	// 4. Active provider key present (env/keyring/config): FAIL when missing.
	if (providerId && listProviders().some((p) => p.id === providerId)) {
		const probe = providerCheck(providerId, env, {
			apiKey: configApiKey,
			provider: configProvider,
		});
		checks.push(
			probe.ok
				? { name: "auth", severity: "OK", detail: `${providerId}: key present` }
				: { name: "auth", severity: "FAIL", detail: probe.message },
		);
	} else if (!providerId) {
		checks.push({ name: "auth", severity: "FAIL", detail: "skipped: config did not resolve" });
	}

	// 5. Cache dir writable + size/entries: WARN-only.
	try {
		const { config } = await loadConfig({ cwd, env });
		configureCache(config.cacheSize, undefined, config.cacheMaxAgeDays);
		const stats = await cacheStats();
		const dir = path.dirname(stats.path);
		const probe = await (deps.cacheWritable ?? defaultCacheWritable)(dir);
		if (probe.writable) {
			checks.push({
				name: "cache",
				severity: "OK",
				detail: `${stats.entries} entries at ${stats.path}`,
			});
		} else {
			checks.push({
				name: "cache",
				severity: "WARN",
				detail: `${dir} not writable${probe.detail ? `: ${probe.detail}` : ""}`,
			});
		}
	} catch (err) {
		checks.push({
			name: "cache",
			severity: "WARN",
			detail: `unavailable: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	// 6. Keyring backend loadable: WARN-only (env keys work without it).
	checks.push(
		keyringAvailable()
			? { name: "keyring", severity: "OK", detail: "backend loadable" }
			: {
					name: "keyring",
					severity: "WARN",
					detail: "unavailable (env keys still work; VP_KEYRING=0 disables)",
				},
	);

	// 7. Integrations installed + outdated markers: WARN-only informational.
	try {
		const text = deps.integrationStatusText
			? await deps.integrationStatusText()
			: (await integrationStatus()).message;
		const firstLine = text.split("\n")[0] ?? "";
		const outdated = /out of date|legacy artifact/.test(text);
		checks.push({
			name: "integrations",
			severity: outdated ? "WARN" : "OK",
			detail: outdated
				? "some integrations need refresh; run `vp integration status`"
				: firstLine || "status checked",
		});
	} catch (err) {
		checks.push({
			name: "integrations",
			severity: "WARN",
			detail: `status failed: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	// 8. dist/ build present (source checkouts): WARN-only.
	const present = deps.distPresent
		? deps.distPresent()
		: existsSync(path.join(runningRoot(), "dist", "cli.js"));
	checks.push(
		present
			? { name: "build", severity: "OK", detail: "dist/ present" }
			: { name: "build", severity: "WARN", detail: "dist/ missing; run `npm run build`" },
	);

	const failed = checks.some((c) => c.severity === "FAIL");
	const ok = !failed;
	if (opts.json) {
		return {
			ok,
			message: JSON.stringify(
				{ ok, checks: checks.map((c) => ({ name: c.name, status: c.severity, detail: c.detail })) },
				null,
				2,
			),
			code: ok ? 0 : 1,
			checks,
		};
	}
	return { ok, message: checks.map(line).join("\n"), code: ok ? 0 : 1, checks };
}

function runningRoot(): string {
	// src/commands/doctor.ts -> repo root; dist/commands/doctor.js -> dist -> root.
	return path.resolve(new URL(".", import.meta.url).pathname, "..", "..");
}

async function readEnginesRequirement(): Promise<string> {
	const pkgPath = path.join(runningRoot(), "package.json");
	const { readFile } = await import("node:fs/promises");
	const raw = await readFile(pkgPath, "utf8");
	const parsed = JSON.parse(raw) as { engines?: { node?: string } };
	return parsed.engines?.node ?? ">=22.6.0";
}

/** Cache dir used by the writable check (the parent of the cache file). */
export function cacheDirFor(env: NodeJS.ProcessEnv = process.env): string {
	return env.VP_CACHE_DIR ?? path.join(os.homedir(), ".vision-proxy");
}
