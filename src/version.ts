/**
 * Single source of truth for the running vision-proxy version.
 *
 * The version is read from `package.json` at build/run time so the CLI, the
 * generated Pi extension, and the hook shims all agree on the same number.
 * `integration status` compares this against the version marker embedded in
 * each installed artifact to flag integrations that predate the current `vp`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function readVersion(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "..", "package.json"), // dist/version.js -> repo root
		join(here, "..", "..", "package.json"), // src/version.ts -> repo root
	];
	for (const p of candidates) {
		try {
			const pkg = require(p) as { version?: string };
			if (pkg.version) return pkg.version;
		} catch {
			/* try next candidate */
		}
	}
	return "0.0.0";
}

/** The running vision-proxy version, e.g. "0.1.0". */
export const VERSION = readVersion();

/** Marker text embedded in generated artifacts so the version can be recovered. */
export const VERSION_MARKER_PREFIX = "__VP_VERSION__:";

/** Build the marker line embedded at the top of every generated artifact. */
export function renderVersionMarker(): string {
	return `${VERSION_MARKER_PREFIX}${VERSION}`;
}

/** Extract a version from a marker line embedded in a generated artifact. */
export function extractMarkerVersion(text: string): string | undefined {
	const m = text.match(
		new RegExp(`${VERSION_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\s"'\`]+)`),
	);
	return m ? m[1]! : undefined;
}
