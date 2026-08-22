/**
 * `vp update` - self-update for curl-installed CLI binaries, with package
 * manager guidance for Homebrew, npm, and source builds.
 *
 * Install method is detected from the realpath of the running binary:
 *   - curl       ~/.local/share/vision-proxy/...   -> delegate to install.sh
 *   - homebrew   /Cellar/ or /homebrew/ in path    -> print brew guidance
 *   - npm        node_modules in path              -> print npm guidance
 *   - source     everything else                   -> print source guidance
 *
 * For curl installs the actual download, checksum verification, and symlink
 * creation are delegated to scripts/install.sh so there is a single source of
 * truth for installer behavior.
 *
 * The module also owns the background update notifier: a cached release tag in
 * ~/.vision-proxy/update-check.json is read synchronously on CLI startup, and
 * the network probe that refreshes it runs in a detached child process so no
 * user-facing command ever waits on GitHub.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../version.ts";
import { vpEntryToSpawn } from "./hook.ts";

export type InstallMethod = "curl" | "homebrew" | "npm" | "source";

const DEFAULT_REPO = "tan-yong-sheng/vision-proxy";

/** Ceiling on the release probe so a background check can never linger. */
const PROBE_TIMEOUT_MS = 5000;

export interface UpdateResult {
	ok: boolean;
	message: string;
	code: number;
}

export interface UpdateOptions {
	/** `--check` / `-c`: report only, never modify files. */
	check?: boolean;
	/** `--version <tag>`: install a pinned release tag (e.g. "v0.1.0"). */
	version?: string;
	/** `--force` / `-f`: reinstall even when already at the latest. */
	force?: boolean;
	/** Resolved realpath of the running CLI binary. Defaults to realpath(argv[1]). */
	binPath?: string;
	/** Override the install script URL (used in tests). */
	installScriptUrl?: string;
	/** Override the GitHub owner/repo. */
	repo?: string;
	/** Inject the HTTP probe used to resolve the latest release (tests). */
	httpProbe?: (url: string) => Promise<string | null>;
	/** Inject the installer runner (tests). Receives [scriptUrl, ...flags]. */
	runner?: (args: string[]) => Promise<number>;
	/** Log sink; defaults to stdout. */
	log?: (msg: string) => void;
	/** Current running version; defaults to the built-in VERSION. */
	currentVersion?: string;
}

/** Typed error for update failures, so callers can branch on the cause. */
export class UpdateError extends Error {}

/** Strip a leading "v" so "v0.1.2" and "0.1.2" compare equal. */
export function normalizeVersion(v: string): string {
	return v.replace(/^v/i, "");
}

/**
 * Detect how vision-proxy was installed from the resolved realpath of the
 * running binary.
 */
export function detectInstallMethod(binPath: string): InstallMethod {
	if (binPath.includes("Cellar") || binPath.includes("homebrew")) return "homebrew";
	if (binPath.includes("node_modules")) return "npm";
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const curlRoot = path.join(home, ".local", "share", "vision-proxy");
	if (home && (binPath.startsWith(curlRoot) || binPath.includes(curlRoot))) return "curl";
	return "source";
}

/** Resolve the realpath of the running CLI binary (best-effort). */
export function resolveBinPath(): string {
	try {
		const p = process.argv[1] ?? "";
		return p ? realpathSync(p) : "";
	} catch {
		return process.argv[1] ?? "";
	}
}

/** Probe a GitHub release redirect and return the resolved release tag. */
async function defaultProbe(url: string): Promise<string | null> {
	const res = await fetch(url, {
		redirect: "manual",
		method: "GET",
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	const loc = res.headers.get("location");
	if (!loc) return null;
	const tag = loc.split("/tag/")[1];
	if (!tag) return null;
	return decodeURIComponent(tag).replace(/\/$/, "");
}

/** Resolve the latest release tag from the GitHub `/releases/latest` redirect. */
export async function fetchLatestVersion(
	repo = DEFAULT_REPO,
	probe: (url: string) => Promise<string | null> = defaultProbe,
	attempts = 3,
): Promise<string> {
	const url = `https://github.com/${repo}/releases/latest`;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const tag = await probe(url);
			if (tag) return tag;
		} catch (e) {
			lastErr = e;
		}
		if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000));
	}
	const detail =
		lastErr instanceof Error ? lastErr.message : String(lastErr ?? "no redirect header");
	throw new UpdateError(`could not resolve latest release from ${url} (${detail})`);
}

/** Validate a release tag to keep it safe inside a shell pipeline. */
function isValidTag(tag: string): boolean {
	return /^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(tag);
}

function defaultRunner(scriptUrl: string, version: string): Promise<number> {
	if (!isValidTag(version)) {
		throw new UpdateError(`invalid version tag: ${version}`);
	}
	const flag = ` --version ${version}`;
	return new Promise<number>((resolve, reject) => {
		const child = spawn("sh", ["-c", `curl -fsSL '${scriptUrl}' | sh -s --${flag}`], {
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

function runInstaller(version: string, opts: UpdateOptions): Promise<number> {
	const repo = opts.repo ?? DEFAULT_REPO;
	const url =
		opts.installScriptUrl ?? `https://raw.githubusercontent.com/${repo}/main/scripts/install.sh`;
	if (opts.runner) return opts.runner([url, "--version", version]);
	return defaultRunner(url, version);
}

function guideMessage(method: InstallMethod): string {
	switch (method) {
		case "homebrew":
			return `vision-proxy was installed via Homebrew. Run 'brew upgrade vision-proxy' to update.`;
		case "npm":
			return `vision-proxy was installed via npm. Run 'npm install -g vision-proxy' to update.`;
		case "source":
			return `vision-proxy is running from a local source build. Pull latest changes and run 'npm run build'.`;
		default:
			return "";
	}
}

/**
 * Run the update flow: detect install method, then either delegate to
 * install.sh (curl) or print package-manager guidance.
 */
export async function runUpdate(opts: UpdateOptions = {}): Promise<UpdateResult> {
	const log = opts.log ?? ((m: string) => process.stdout.write(`${m}\n`));
	const currentVersion = opts.currentVersion ?? VERSION;
	const repo = opts.repo ?? DEFAULT_REPO;
	const binPath = opts.binPath ?? resolveBinPath();
	const method = detectInstallMethod(binPath);

	if (method !== "curl") {
		return { ok: true, message: guideMessage(method), code: 0 };
	}

	const targetVersion = opts.version;

	let latest: string;
	if (targetVersion) {
		latest = targetVersion;
	} else {
		try {
			latest = await fetchLatestVersion(repo, opts.httpProbe);
		} catch (e) {
			return {
				ok: false,
				message: `update failed: ${e instanceof Error ? e.message : String(e)}`,
				code: 1,
			};
		}
	}

	const upToDate = normalizeVersion(latest) === normalizeVersion(currentVersion);

	if (opts.check) {
		if (upToDate) {
			return {
				ok: true,
				message: `vision-proxy is already up to date (v${normalizeVersion(currentVersion)})`,
				code: 0,
			};
		}
		return {
			ok: true,
			message: `A new version of vision-proxy is available: ${latest}. Run 'vp update' to upgrade.`,
			code: 0,
		};
	}

	if (!opts.force && !targetVersion && upToDate) {
		return {
			ok: true,
			message: `vision-proxy is already up to date (v${normalizeVersion(currentVersion)})`,
			code: 0,
		};
	}

	log(`Updating vision-proxy to ${latest}...`);
	try {
		const code = await runInstaller(latest, opts);
		if (code !== 0) {
			return {
				ok: false,
				message: `update failed: installer exited with code ${code}`,
				code: code || 1,
			};
		}
	} catch (e) {
		return {
			ok: false,
			message: `update failed: ${e instanceof Error ? e.message : String(e)}`,
			code: 1,
		};
	}
	return { ok: true, message: `vision-proxy updated to ${latest}.`, code: 0 };
}

// ── Background update notifier ─────────────────────────────────────────────

/** How long a cached release tag stays fresh before a refresh is spawned. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCache {
	/** ISO timestamp of the last successful release probe. */
	checked_at: string;
	/** Release tag resolved by that probe, e.g. "v0.1.2". */
	latest_version: string;
}

export interface NotifierEnvironment {
	env?: NodeJS.ProcessEnv;
	/** Directory holding update-check.json. Defaults to ~/.vision-proxy. */
	cacheDir?: string;
	/** Current running version; defaults to the built-in VERSION. */
	currentVersion?: string;
	/** Command being run, used to keep `vp hook` output pristine. */
	command?: string;
	/** Whether the active command emits machine-readable JSON. */
	json?: boolean;
	/** stderr TTY state; defaults to the real stream. */
	isTTY?: boolean;
	/** stderr sink; defaults to process.stderr. */
	warn?: (msg: string) => void;
	/** Inject the detached spawn (tests). */
	spawner?: (command: string, args: string[], env: NodeJS.ProcessEnv) => void;
}

function updateCacheDir(opts: NotifierEnvironment = {}): string {
	const env = opts.env ?? process.env;
	return opts.cacheDir ?? env.VP_CACHE_DIR ?? path.join(os.homedir(), ".vision-proxy");
}

function updateCachePath(opts: NotifierEnvironment = {}): string {
	return path.join(updateCacheDir(opts), "update-check.json");
}

/** Read the cached release tag. Returns null when missing, unreadable, or malformed. */
export function loadUpdateCache(opts: NotifierEnvironment = {}): UpdateCache | null {
	try {
		const parsed = JSON.parse(readFileSync(updateCachePath(opts), "utf8")) as Partial<UpdateCache>;
		if (typeof parsed?.checked_at !== "string" || typeof parsed?.latest_version !== "string") {
			return null;
		}
		return { checked_at: parsed.checked_at, latest_version: parsed.latest_version };
	} catch {
		return null;
	}
}

/** Persist the resolved release tag. Silently gives up when the write fails. */
export function saveUpdateCache(cache: UpdateCache, opts: NotifierEnvironment = {}): void {
	try {
		mkdirSync(updateCacheDir(opts), { recursive: true, mode: 0o700 });
		writeFileSync(updateCachePath(opts), JSON.stringify(cache), {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		// A missing cache only costs a redundant probe next time.
	}
}

/** True when the cache is absent or older than the TTL. */
export function isUpdateCacheStale(cache: UpdateCache | null, now = Date.now()): boolean {
	if (!cache) return true;
	const checkedAt = Date.parse(cache.checked_at);
	if (Number.isNaN(checkedAt)) return true;
	return now - checkedAt >= UPDATE_CHECK_TTL_MS;
}

/** Compare release tags numerically so v0.10.0 sorts above v0.9.0. */
export function isNewerVersion(candidate: string, current: string): boolean {
	const parse = (v: string) =>
		normalizeVersion(v)
			.split("-")[0]!
			.split(".")
			.map((p) => Number.parseInt(p, 10));
	const a = parse(candidate);
	const b = parse(current);
	if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const left = a[i] ?? 0;
		const right = b[i] ?? 0;
		if (left !== right) return left > right;
	}
	return false;
}

/**
 * Whether the notifier may write to stderr and spawn probes at all.
 *
 * `vp hook` feeds an agent's context window, so any stray byte there is a
 * correctness bug rather than a cosmetic one.
 */
export function isNotifierSuppressed(opts: NotifierEnvironment = {}): boolean {
	const env = opts.env ?? process.env;
	if (opts.command === "hook") return true;
	if (opts.json) return true;
	if (env.VP_NO_UPDATE_NOTIFIER) return true;
	if (env.CI) return true;
	return !(opts.isTTY ?? process.stderr.isTTY);
}

/** Render the banner shown when a newer release is cached. */
export function renderUpdateNotice(latest: string, current: string): string {
	return `A new version of vision-proxy is available: v${normalizeVersion(latest)} (current: v${normalizeVersion(current)}). Run 'vp update' to upgrade.`;
}

/**
 * Spawn a detached `vp update --background-check` to refresh the cache.
 *
 * The child is fully detached with ignored stdio so it cannot hold the parent's
 * event loop open or leak output into the caller's streams.
 */
export function spawnBackgroundUpdateCheck(opts: NotifierEnvironment = {}): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	const childEnv = { ...(opts.env ?? process.env), VP_NO_UPDATE_NOTIFIER: "1" };
	try {
		const { command, args } = vpEntryToSpawn(entry);
		const argv = [...args, "update", "--background-check"];
		if (opts.spawner) {
			opts.spawner(command, argv, childEnv);
			return true;
		}
		const child = spawn(command, argv, {
			detached: true,
			stdio: "ignore",
			env: childEnv,
		});
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/**
 * Startup hook: print a banner when the cached tag is newer than the running
 * version, and refresh a stale cache in the background. Never throws, never
 * blocks on the network.
 */
export function checkAutoUpdateNotification(opts: NotifierEnvironment = {}): void {
	if (isNotifierSuppressed(opts)) return;
	const current = opts.currentVersion ?? VERSION;
	const cache = loadUpdateCache(opts);
	if (cache && isNewerVersion(cache.latest_version, current)) {
		const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
		warn(`\n${renderUpdateNotice(cache.latest_version, current)}\n`);
	}
	if (isUpdateCacheStale(cache)) spawnBackgroundUpdateCheck(opts);
}

/**
 * Worker for the internal `--background-check` flag: resolve the latest release
 * tag and persist it. Runs detached, so failures are swallowed by design.
 */
export async function runBackgroundCheck(
	opts: NotifierEnvironment & {
		repo?: string;
		httpProbe?: (url: string) => Promise<string | null>;
	} = {},
): Promise<void> {
	try {
		const latest = await fetchLatestVersion(opts.repo ?? DEFAULT_REPO, opts.httpProbe, 1);
		saveUpdateCache({ checked_at: new Date().toISOString(), latest_version: latest }, opts);
	} catch {
		// Offline or rate-limited: leave the old cache and retry after the TTL.
	}
}
