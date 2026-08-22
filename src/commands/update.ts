/**
 * `vp update` — self-update for curl-installed CLI binaries, with package
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
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { VERSION } from "../version.ts";

export type InstallMethod = "curl" | "homebrew" | "npm" | "source";

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
	const res = await fetch(url, { redirect: "manual", method: "GET" });
	const loc = res.headers.get("location");
	if (!loc) return null;
	const tag = loc.split("/tag/")[1];
	if (!tag) return null;
	return decodeURIComponent(tag).replace(/\/$/, "");
}

/** Resolve the latest release tag from the GitHub `/releases/latest` redirect. */
export async function fetchLatestVersion(
	repo = "tan-yong-sheng/vision-proxy",
	probe: (url: string) => Promise<string | null> = defaultProbe,
): Promise<string> {
	const url = `https://github.com/${repo}/releases/latest`;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const tag = await probe(url);
			if (tag) return tag;
		} catch (e) {
			lastErr = e;
		}
		if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
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
	const repo = opts.repo ?? "tan-yong-sheng/vision-proxy";
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
	const repo = opts.repo ?? "tan-yong-sheng/vision-proxy";
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
