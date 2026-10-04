/**
 * Canonical standalone hook runtime.
 *
 * Single home for the analysis policy shared by every generated host artifact
 * (Claude/Codex stdio hook script, Pi extension): image path
 * classification, path extraction, env parsing, reminder and instruction
 * rendering, vp command resolution, and analyze argument construction. Each
 * host adapter calls into this policy and owns only its lifecycle translation:
 * event shapes, image-cache refs (Claude/Codex only), mode gating (Pi only),
 * sync/async executors, and deny/output shapes.
 *
 * Standalone constraint: the generated artifacts must run with no
 * vision-proxy package present (plain node --experimental-strip-types, Pi jiti), so this module ships its policy in two shapes from one source of
 * truth:
 *
 * - real functions below, which repo unit tests exercise directly
 *   (`vpEntryToSpawn` is the one exception: it lives in `src/vp-entry.ts`,
 *   the single source shared with the update notifier, and is re-exported
 *   here so the command and test API is unchanged);
 * - HOOK_RUNTIME_SOURCE, a standalone source string composed from those same
 *   functions via toString and inlined into each emitted file at generate()
 *   time by the per-host source modules.
 *
 * Rules for every function composed into HOOK_RUNTIME_SOURCE (enforced by
 * golden tests on the final artifacts):
 * - no backtick and no dollar-sign-plus-brace anywhere in the body, including
 *   comments, because host modules embed the source with String.raw;
 * - no imports beyond what each generated file already provides (node:os
 *   homedir, node:path join/resolve, and the process global);
 * - plain function declarations with no export keyword, so toString yields a
 *   clean function statement in every engine.
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vpEntryToSpawn } from "../vp-entry.ts";

/** Known image file extensions (lowercased, no dot). Shared by every host adapter. */
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "ico", "avif"];

/**
 * Marker prefix on injected reminders. Hosts whose lifecycle re-fires for the
 * same message (Pi context) strip their own prior
 * reminders by this prefix so context never stacks duplicates.
 */
const REMINDER_MARKER = "[vision-proxy:read-reminder]";

/** Shared VP_HOOK_TIMEOUT_MS default and accepted range. */
const DEFAULT_HOOK_TIMEOUT_MS = 30000;
const MIN_HOOK_TIMEOUT_MS = 1000;
const MAX_HOOK_TIMEOUT_MS = 600000;

/** Shared VP_MAX_OUTPUT_TOKENS default and accepted range. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const MIN_MAX_OUTPUT_TOKENS = 1;
const MAX_MAX_OUTPUT_TOKENS = 1000000;

/**
 * Pilot table for the two numeric hook settings (Q4): each row names the
 * env var and references its canonical default and accepted range, so the
 * rows stay aligned with the parsers below. Only the numeric settings fit
 * this shape (name, fallback, min, max): VP_BIN is a string and VP_MODE is
 * an enum, so they stay on their own resolvers. The full 20-setting table
 * is a later change, not this one (Q7: not now). Plain data — no backtick,
 * no ${ — so it composes into HOOK_RUNTIME_SOURCE like every other
 * canonical value.
 *
 * @tags integrations, runtime
 */
interface HostEnvSpec {
	name: string;
	fallback: number;
	min: number;
	max: number;
}
var HOST_ENV: HostEnvSpec[] = [
	{
		name: "VP_HOOK_TIMEOUT_MS",
		fallback: DEFAULT_HOOK_TIMEOUT_MS,
		min: MIN_HOOK_TIMEOUT_MS,
		max: MAX_HOOK_TIMEOUT_MS,
	},
	{
		name: "VP_MAX_OUTPUT_TOKENS",
		fallback: DEFAULT_MAX_OUTPUT_TOKENS,
		min: MIN_MAX_OUTPUT_TOKENS,
		max: MAX_MAX_OUTPUT_TOKENS,
	},
];

/** Shared cap on captured vp analyze output. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Default analyzer command for generated artifacts. */
const DEFAULT_VP_BIN = "vp";

/**
 * Shared bounds for the last-N conversation context passed to `vp analyze`
 * via `--context`: how many messages are kept, how much assistant text each
 * contributes, and the total context size. Values mirror the canonical
 * formatter in `src/core.ts` so the host artifacts and the CLI stay in sync.
 */
const RECENT_MESSAGE_COUNT = 16;
const ASSISTANT_TRUNCATE_CHARS = 3000;
const CONTEXT_MAX_CHARS = 20000;

function parsePositiveInt(raw: unknown, fallback: number, min: number, max: number): number {
	var n = parseInt(raw == null ? "" : String(raw), 10);
	if (!Number.isFinite(n) || n < min || n > max) return fallback;
	return n;
}

function hookTimeoutMs(raw: unknown): number {
	return parsePositiveInt(raw, DEFAULT_HOOK_TIMEOUT_MS, MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
}

function maxOutputTokens(raw: unknown): number {
	return parsePositiveInt(
		raw,
		DEFAULT_MAX_OUTPUT_TOKENS,
		MIN_MAX_OUTPUT_TOKENS,
		MAX_MAX_OUTPUT_TOKENS,
	);
}

/**
 * Shared off-switch check (Q2): one rule for both hosts. VP_MODE=off stops
 * analysis; anything else (unset, "always", garbage, or the saved config
 * value the adapters resolve) keeps it on. Takes the already-resolved mode
 * string so each adapter keeps its own lookup (env-live in both; Pi adds
 * its cached config-file fallback) while the decision lives here.
 * Standalone-safe: string comparison only, no backtick, no ${.
 *
 * @tags integrations, runtime
 */
function isAnalysisDisabled(mode: unknown): boolean {
	return mode === "off";
}

/**
 * Live timeout read (Q3): one rule for both hosts. Pi used to freeze
 * VP_HOOK_TIMEOUT_MS at startup; the hook re-read on every call. Both now
 * call this per invocation so a timeout change needs no restart — the same
 * rationale as the live off-switch. Takes the raw env value (adapters pass
 * process.env.VP_HOOK_TIMEOUT_MS) so no env access hides inside the
 * canonical module. Standalone-safe: delegation only, no backtick, no ${.
 *
 * @tags integrations, runtime
 */
function resolveHookTimeout(raw: unknown): number {
	return hookTimeoutMs(raw);
}

/**
 * Live token-cap read: same shape as resolveHookTimeout, so timeout and
 * tokens stay symmetric at every call site. Standalone-safe.
 *
 * @tags integrations, runtime
 */
function resolveMaxOutputTokens(raw: unknown): number {
	return maxOutputTokens(raw);
}

// NOTE: vpEntryToSpawn is intentionally not defined here. It lives in
// src/vp-entry.ts (shared with the update notifier) and is re-exported
// through this module's export list so the command and test API is unchanged.

function resolveVpBin(): string {
	var env = process.env.VP_BIN;
	if (env?.trim()) return env.trim();
	return DEFAULT_VP_BIN;
}

/** Analyze invocation extras: sensitive text delivered to the child via stdin.
 *
 * question/context are never part of argv (see buildAnalyzeArgs): they travel
 * inside the JSON payload on stdin so a local process listing cannot capture
 * conversation content from the command line.
 *
 * @tags integrations, runtime
 */
interface AnalyzeExtras {
	question?: string;
	context?: string;
}

/**
 * Analyze-payload marker read by `vp analyze` on stdin. Host adapters never
 * send this when there is nothing sensitive to transmit: a call with no
 * question/context keeps the historical
 * "vp analyze <images> --max-output-tokens N" argv byte-identical and writes
 * no stdin at all, so every pre-existing call site is unchanged.
 *
 * @tags integrations, runtime
 */
var ANALYZE_STDIN_MARKER = "vp-analyze-payload-v1";

/**
 * Build the argv and stdin for one analyze invocation.
 *
 * Argv carries only non-sensitive routing (images, max-output-tokens): when
 * extras hold a non-empty question/context the caller also writes the
 * returned stdin payload to the child's stdin so conversation text never
 * appears in the process listing (CWE-214). Returns an empty stdin string
 * when there is nothing sensitive to send.
 *
 * @tags integrations, runtime
 */
function buildAnalyzeArgs(
	images: string[],
	maxTokens: number,
	extras?: AnalyzeExtras,
): { command: string; args: string[]; stdin: string } {
	var vp = resolveVpBin();
	var prefix = vpEntryToSpawn(vp);
	var args = prefix.args.concat(["analyze"], images, ["--max-output-tokens", String(maxTokens)]);
	var question = "";
	var context = "";
	if (extras) {
		question = typeof extras.question === "string" ? extras.question.trim() : "";
		context = typeof extras.context === "string" ? extras.context.trim() : "";
	}
	// Sensitive text goes on stdin, never argv. The marker line lets the
	// analyze parser distinguish a payload from the provider store-key key
	// bytes (which never start with the marker).
	var stdin = "";
	if (question || context) {
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		stdin = ANALYZE_STDIN_MARKER + "\n" + JSON.stringify({ question: question, context: context });
	}
	// Keep the historical question flag for backwards compatibility with
	// older wrappers that still pass --question/--context on the command
	// line; new callers (this repo's adapters) prefer the stdin payload.
	return { command: prefix.command, args: args, stdin: stdin };
}

/**
 * Cap (bytes) on a `--context-file` payload written by a hook. Mirrors
 * MAX_ANALYZE_STDIN_BYTES in src/command-runner.ts so what the CLI accepts
 * and what hooks write stay in sync.
 *
 * @tags integrations, runtime
 */
var CONTEXT_FILE_MAX_BYTES = 256 * 1024;

/**
 * Basename prefix for hook-written explicit handoff files: each file is
 * created exclusively (O_EXCL, mode 0600) with 128-bit random entropy and
 * deleted by the CLI after reading. Files never sit beside user data —
 * they live in a dedicated directory under the OS temp root.
 *
 * Canonical home of the host-policy tempfile pipeline: the per-host
 * adapters (hook script, Pi extension) carry no copy of their own. Every
 * function below is composed into HOOK_RUNTIME_SOURCE via toString, so it
 * must satisfy the standalone rules (no backtick, no ${, 2-space
 * indent, imports limited to what each generated header provides:
 * node:crypto randomBytes, node:fs
 * chmodSync/closeSync/lstatSync/mkdirSync/openSync/readdirSync/rmSync/
 * statSync/writeFileSync, node:os tmpdir, node:path join, and the
 * process global). Consumers must NOT guard with typeof checks on those
 * imports: the generated headers always provide them and the golden
 * tests pin standalone validity. The Buffer global is the one exception:
 * the Pi header provides no node:buffer import, so utf8ByteLength guards
 * it with typeof and every artifact test pins the guard.
 *
 * @tags integrations, runtime
 */
var CONTEXT_FILE_PREFIX = "vp-context-";
/** Stale-file TTL: handoffs older than this are pruned before each write. */
var CONTEXT_FILE_TTL_MS = 10 * 60 * 1000;

/**
 * Well-known pending file for deterministic auto-discovery (Phase 1): a
 * single last-writer-wins slot the CLI reads when no explicit
 * --context-file flag is present.
 */
var PENDING_CONTEXT_FILE_NAME = "__pending__.txt";
/**
 * Pending freshness window, mirroring the CLI reader TTL
 * (src/command-runner.ts PENDING_CONTEXT_TTL_MS): a pending file no agent
 * invocation ever reads must not linger past the window in which any
 * analyze call would accept it.
 */
var PENDING_CONTEXT_TTL_MS = 60 * 1000;

function contextFileDir(): string {
	var base = "";
	var tmp: string | undefined;
	try {
		tmp = process.env.TMPDIR || process.env.TMP || process.env.TEMP;
		if (tmp?.trim()) base = tmp.trim();
	} catch {
		base = "";
	}
	if (!base) {
		try {
			base = tmpdir();
		} catch {
			base = "";
		}
	}
	if (!base) base = "/tmp";
	return join(base, "vision-proxy-context");
}

/**
 * True when an existing context directory is safe to use: not a symlink,
 * owned by the current user, and (unless lax modes are being repaired)
 * mode 0700 with no group/world access (POSIX only; on Windows the mode
 * check is skipped and privacy relies on per-user temp ACL inheritance).
 * Fail-closed on any stat failure so callers abort rather than write into
 * an untrusted directory.
 */
function isSafeContextDir(dir: string, allowLaxMode?: boolean): boolean {
	var st = null;
	try {
		st = lstatSync(dir);
	} catch {
		return false;
	}
	if (!st) return false;
	try {
		if (st.isSymbolicLink()) return false;
	} catch {
		return false;
	}
	try {
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
	} catch {
		return false;
	}
	// Windows has no POSIX owner/group/other bits: mkdir ignores mode and
	// chmod only toggles the read-only flag, so the bit check is skipped
	// there and privacy relies on the per-user temp directory ACL
	// inheritance. Ownership and symlink checks always apply where available.
	// Lax group/world bits are tolerated only on the pre-repair pass: an
	// existing 0755 directory owned by us is repaired to 0700 below, then
	// rechecked strictly.
	if (!allowLaxMode && process.platform !== "win32") {
		try {
			if ((st.mode & 0o077) !== 0) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Ensure the context directory exists as a private directory: create with
 * mode 0700 when missing, then always validate (fresh or reused) before
 * use. A recursive mkdir that succeeds on an existing directory must not
 * bypass the ownership/permission checks, so validation runs on both
 * paths; lax modes are repaired with chmod 0700 and rechecked. Returns
 * false on any failure (fail open: the caller runs the original command
 * unchanged).
 */
function ensurePrivateContextDir(dir: string): boolean {
	try {
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch {
			// Exists already or raced creation: fall through to validation.
		}
		// Never trust a fresh-or-reused directory without validating: a
		// pre-created directory may carry permissive modes, wrong ownership,
		// or be a symlink, and recursive mkdir succeeds on it silently.
		// Ownership/symlink are checked first so only our own lax directory
		// reaches the chmod repair; the strict recheck then enforces 0700
		// (POSIX; on Windows the mode bits are not meaningful and ACL
		// inheritance is relied upon).
		if (!isSafeContextDir(dir, true)) return false;
		try {
			chmodSync(dir, 0o700);
		} catch {
			// Non-fatal: the strict recheck below still enforces the mode.
		}
		// Recheck after the repair attempt so a failed chmod cannot leave a
		// lax directory in use (POSIX; skipped on Windows where chmod is a
		// read-only-flag no-op).
		return isSafeContextDir(dir);
	} catch {
		return false;
	}
}

/**
 * Best-effort prune of stale vp-context-*.txt files older than the TTL.
 * Fail-open: every failure is swallowed so pruning never blocks the
 * handoff. Runs before each write so rejected or interrupted handoffs
 * cannot accumulate forever.
 */
function pruneStaleContextFiles(dir: string): void {
	var entries = null;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	if (!entries) return;
	var now = Date.now();
	var i = 0;
	var name = "";
	var isPending = false;
	var full = "";
	var age = -1;
	var ttl = CONTEXT_FILE_TTL_MS;
	for (i = 0; i < entries.length; i++) {
		name = entries[i] || "";
		// Sweep the random explicit handoffs plus a stale pending fallback:
		// a pending file no agent invocation ever reads would otherwise linger
		// past its TTL with nobody to delete-on-read it.
		isPending = name === PENDING_CONTEXT_FILE_NAME;
		full = "";
		age = -1;
		ttl = CONTEXT_FILE_TTL_MS;
		if (!isPending && name.indexOf(CONTEXT_FILE_PREFIX) !== 0) continue;
		if (name.slice(-4) !== ".txt") continue;
		full = join(dir, name);
		try {
			age = now - statSync(full).mtimeMs;
		} catch {
			continue;
		}
		// Pending uses the shorter reader TTL so a never-read slot cannot
		// outlive the window in which any analyze call would accept it.
		ttl = isPending ? PENDING_CONTEXT_TTL_MS : CONTEXT_FILE_TTL_MS;
		if (age < 0 || age <= ttl) continue;
		try {
			rmSync(full, { force: true });
		} catch {
			// ignore: best-effort cleanup
		}
	}
}

function pendingContextFilePath(): string {
	return join(contextFileDir(), PENDING_CONTEXT_FILE_NAME);
}

/**
 * Byte length of a UTF-8 string without assuming a Buffer global.
 * The Pi generated header provides no Buffer import, so the canonical
 * runtime must not throw ReferenceError there: when Buffer is absent the
 * length check falls back to a 3-bytes-per-char upper bound (never
 * under-counts, so the cap still enforced) and the write proceeds.
 * Written with a declared-global indirection because a bare `Buffer?.`
 * reference still throws ReferenceError when no binding exists.
 * Standalone-safe: no backtick, no ${.
 *
 * @tags integrations, runtime
 */
declare const Buffer: { byteLength(text: string, encoding: string): number } | undefined;
function utf8ByteLength(text: string): number {
	// The typeof guard is the fix: Buffer?.byteLength alone throws
	// ReferenceError when no binding exists (the Pi artifact ships no
	// node:buffer import), so this keeps the two-step shape.
	const byteLength = typeof Buffer !== "undefined" ? Buffer?.byteLength : undefined;
	if (typeof byteLength === "function") {
		try {
			return byteLength(text, "utf8");
			// fall through to the estimate below when the call throws
		} catch {
			// ignore: fall through
		}
	}
	return text.length * 3;
}

function writePendingContextFile(context: string): string | null {
	if (!context) return null;
	if (utf8ByteLength(context) > CONTEXT_FILE_MAX_BYTES) return null;
	var dir = contextFileDir();
	var path = "";
	var fd2 = -1;
	try {
		if (!ensurePrivateContextDir(dir)) return null;
		pruneStaleContextFiles(dir);
		path = pendingContextFilePath();
		// Overwrite deterministically — last writer wins, delete-on-read
		// prevents cross-turn reuse. 0600 here is advisory; the dir gate is
		// the privacy boundary (Windows relies on ACL inheritance).
		try {
			// Remove any prior pending so open("wx") can create fresh.
			rmSync(path, { force: true });
		} catch {
			// ignore
		}
		try {
			fd2 = openSync(path, "wx", 0o600);
		} catch {
			return null;
		}
		try {
			writeFileSync(fd2, context, { encoding: "utf8" });
		} catch {
			try {
				closeSync(fd2);
			} catch {
				/* ignore */
			}
			fd2 = -1;
			try {
				rmSync(path, { force: true });
			} catch {
				/* ignore */
			}
			return null;
		} finally {
			if (fd2 !== -1) {
				try {
					closeSync(fd2);
				} catch {
					/* ignore */
				}
			}
		}
		try {
			chmodSync(path, 0o600);
		} catch {
			/* ignore */
		}
		return path;
	} catch {
		return null;
	}
}

/**
 * Persist context text to an exclusively-created 0600 tempfile for
 * context-file handoff. Returns the path, or null on any failure (fail
 * open: the caller runs the original command unchanged).
 */
function writeContextFile(context: string): string | null {
	if (!context) return null;
	if (utf8ByteLength(context) > CONTEXT_FILE_MAX_BYTES) return null;
	var dir = contextFileDir();
	var fd = -1;
	var file = "";
	var attempts = 0;
	var name = "";
	try {
		if (!ensurePrivateContextDir(dir)) return null;
		pruneStaleContextFiles(dir);
		while (fd === -1 && attempts < 5) {
			attempts++;
			// 128-bit random entropy: unlinkable without directory listing,
			// unlike the prior timestamp+pid sequence.
			// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
			name = CONTEXT_FILE_PREFIX + randomBytes(16).toString("hex") + ".txt";
			file = join(dir, name);
			try {
				// O_EXCL: fail when the path already exists instead of following
				// a pre-created symlink or overwriting another process's file.
				fd = openSync(file, "wx", 0o600);
			} catch {
				fd = -1;
				file = "";
			}
		}
		if (fd === -1 || !file) return null;
		try {
			writeFileSync(fd, context, { encoding: "utf8" });
		} catch {
			// A failed write may leave a partial file at its final path with no
			// later prune guaranteed. Close first: unlinking an open descriptor
			// fails on platforms such as Windows, and the finally below would
			// then only close without retrying the removal.
			try {
				closeSync(fd);
			} catch {
				// ignore: descriptor cleanup is best-effort
			}
			fd = -1;
			try {
				rmSync(file, { force: true });
			} catch {
				// ignore: best-effort failure cleanup
			}
			return null;
		} finally {
			// fd is -1 when the catch above already closed it.
			if (fd !== -1) {
				try {
					closeSync(fd);
				} catch {
					// ignore: descriptor cleanup is best-effort
				}
			}
		}
		try {
			chmodSync(file, 0o600);
		} catch {
			// ignore: creation mode already requested 0600
		}
		return file;
	} catch {
		return null;
	}
}

/**
 * True when a shell command string invokes `vp analyze` without already
 * carrying a `--context-file` reference.
 *
 * Token-aware: matches the `vp`/`vision-proxy` binary (optionally via a
 * path or `npx`) followed by the `analyze` subcommand, honoring quoting
 * and `=`-joined flags so a flagged command is never double-appended
 * (which would loop the rewrite on re-fire).
 *
 * @param command The shell command string to inspect.
 * @returns True for an unflagged analyze invocation, false otherwise.
 *
 * @tags integrations, runtime
 */
function isUnflaggedAnalyzeCommand(command: unknown): boolean {
	if (typeof command !== "string" || !command) return false;
	// Shell metacharacters split one command string into separate invocations
	// or redirections: vp analyze adjacent to any of these is not standalone,
	// and appending the flag would land it on the wrong process.
	// Conservative over-match: a quoted operator (for example an image path
	// containing &&) also disqualifies, failing open to no rewrite rather
	// than risking a flag on the wrong process. The literal lives inside the
	// function body (not a module-level var) so the standalone shipped
	// source carries it via toString.
	var chainRe = /&&|\|\||[|&;()<>]/;
	if (chainRe.test(command)) return false;
	var rawTokens = command.match(/'[^']*'|"[^"]*"|\S+/g);
	if (!rawTokens) return false;
	var words: string[] = [];
	var w = "";
	var first = "";
	var last = "";
	var ti = 0;
	for (ti = 0; ti < rawTokens.length; ti++) {
		w = rawTokens[ti];
		if (w.length >= 2) {
			first = w.charAt(0);
			last = w.charAt(w.length - 1);
			if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
				w = w.slice(1, -1);
			}
		}
		words.push(w);
	}
	var idx = -1;
	var parts: string[] = [];
	var base = "";
	var j = 0;
	var nextParts: string[] = [];
	var cand = "";
	var tok = "";
	var i = 0;
	for (i = 0; i < words.length; i++) {
		parts = words[i].split("/");
		base = parts[parts.length - 1] || "";
		if (base === "npx") {
			j = i + 1;
			while (j < words.length && words[j].charAt(0) === "-") j++;
			nextParts = (words[j] || "").split("/");
			cand = nextParts[nextParts.length - 1] || "";
			if (cand !== "vp" && cand !== "vision-proxy") continue;
			i = j;
			base = cand;
		}
		if (base === "vp" || base === "vision-proxy") {
			if (words[i + 1] === "analyze") {
				idx = i;
				break;
			}
			return false;
		}
	}
	if (idx === -1) return false;
	// The binary must be the first word (after an optional npx unwrap
	// above, which advances the scan to the vp token): echo/sudo before
	// vp never execute our binary, so appending the flag would hand
	// context to the wrong process. Env assignments (VAR=1 vp analyze)
	// and wrappers (time, sudo) are rejected the same way: fail open to
	// no rewrite.
	if (words[0] !== "npx" && idx !== 0) return false;
	var k = 0;
	for (k = idx + 2; k < words.length; k++) {
		tok = words[k] || "";
		if (
			tok === "--context-file" ||
			tok === "--contextFile" ||
			tok.indexOf("--context-file=") === 0 ||
			tok.indexOf("--contextFile=") === 0
		) {
			return false;
		}
	}
	return true;
}

/**
 * Append a `--context-file <path>` reference to an analyze command.
 *
 * The caller quotes the path (each adapter owns its host's quoting via
 * the shared quote helper); this helper only joins the tokens so every
 * host appends the same flag spelling.
 *
 * @param command The original shell command.
 * @param quotedPath The already-quoted tempfile path.
 * @returns The rewritten command.
 *
 * @tags integrations, runtime
 */
function appendContextFileArg(command: string, quotedPath: string): string {
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	return command + " --context-file " + quotedPath;
}

// ── Standalone conversation-context formatter ─────────────────────────────
//
// Mirrors buildConversationContext/truncateContext in src/core.ts so the
// generated artifacts can render the analyze payload without importing the
// package. Parity notes: like the canonical formatter this copy drops only
// empty text (if (!text)), keeping whitespace-only content; user text is
// unbounded per-message in both (only the 3000-char total cap applies).
// The input is host-agnostic: an array of { role, content } messages where
// content is a string or an array of blocks; only text blocks count. Each
// host adapter maps its native message shape (Pi entries,
// CC transcript lines, Codex rollout items) before calling.

/**
 * Quote an argv value for the generated shell artifacts.
 *
 * Single source for the POSIX single-quote escaping shared by the hook
 * script and the Pi extension when they append
 * `--context-file <path>` to a model-invoked command. Kept in the
 * canonical runtime so the tested implementation and the shipped source
 * cannot drift; composed into HOOK_RUNTIME_SOURCE like every other
 * shared helper.
 *
 * @param p The path to quote.
 * @returns The shell-safe quoted path.
 *
 * @tags integrations, runtime
 */
function quoteShellArg(p: string): string {
	if (p === "") return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p)) return p;
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	return "'" + p.replace(/'/g, "'\\''") + "'";
}

/**
 * True when a content item is a plain text block (type "text" with string text).
 *
 * @param c The content item to test.
 * @returns True for text blocks, false otherwise.
 */
function isTextBlock(c: unknown): boolean {
	if (!c || typeof c !== "object") return false;
	var block = c as { type?: unknown; text?: unknown };
	return block.type === "text" && typeof block.text === "string";
}

/**
 * Extract the plain text from a message content value.
 *
 * Strings pass through; block arrays contribute only their text blocks;
 * anything else yields "".
 *
 * @param content The message content to read.
 * @returns The concatenated text, or "" when none qualifies.
 *
 * @tags integrations, runtime
 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	var parts: string[] = [];
	for (const c of content) {
		if (isTextBlock(c)) parts.push((c as { text: string }).text);
	}
	return parts.join(" ");
}

/**
 * Cap conversation context while preserving its most recent characters.
 *
 * @param result The conversation context to bound.
 * @returns The bounded conversation context.
 *
 * @tags integrations, runtime
 */
function truncateConversationContext(result: string): string {
	if (result.length <= CONTEXT_MAX_CHARS) return result;
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	return "…" + result.slice(-CONTEXT_MAX_CHARS);
}

/**
 * Render the last N user/assistant messages as bounded plain text, or "" when
 * nothing qualifies. Tool and system entries are excluded on purpose: tool
 * outputs are the highest-volume, lowest-signal text for image grounding
 * (and the widest untrusted-input surface). The result is
 * attacker-controlled input to the vision prompt, so `vp analyze` fences it
 * (context is only sent when configured).
 *
 * @param messages Host-agnostic message list; only user/assistant entries count.
 * @returns The bounded context text, or "" when nothing qualifies.
 *
 * @tags integrations, runtime
 */
function buildConversationContext(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	var msgs: Array<{ role?: unknown; content?: unknown }> = [];
	var msg: { role?: unknown; content?: unknown };
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		msg = m as { role?: unknown; content?: unknown };
		if (msg.role === "user" || msg.role === "assistant") msgs.push(msg);
	}
	var tail = msgs.slice(-RECENT_MESSAGE_COUNT);
	var lines: string[] = [];
	var text = "";
	for (const item of tail) {
		text = extractText(item.content);
		if (!text) continue;
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		if (item.role === "user") lines.push("User: " + text);
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		else lines.push("Assistant: " + text.slice(0, ASSISTANT_TRUNCATE_CHARS));
	}
	return truncateConversationContext(lines.join("\n"));
}

/**
 * String-union of analyze failure causes shared by both host executors.
 *
 * The sync stdio hook and the async Pi extension classify the same child
 * outcomes; the literal strings below preserve the exact model-visible
 * causes hosts already key on (tests match on /was not found/,
 * /exited with status/ ranges), so unification cannot silently reword them.
 *
 * @tags integrations, runtime
 */
export type AnalyzeFailureKind =
	| "not-started"
	| "spawn-failed"
	| "missing-cli"
	| "failed"
	| "failed-or-timed-out"
	| "exit-status"
	| "timed-out"
	| "aborted";

/**
 * Shared failure-cause strings for `vp analyze` executors.
 *
 * One taxonomy for both host adapters: the sync stdio hook (`hook-script`)
 * and the async Pi extension (`pi-extension`) each passed their own cause
 * strings inline, already drifting ("failed or timed out" vs "failed" on
 * the same non-ENOENT outcome). Hosts keep their own executor (sync vs
 * async, extra timeout vs abort paths) but render causes through this one
 * function so the model-visible wording cannot drift again.
 * Standalone-safe: plain concatenation only, no backtick, no ${.
 *
 * @tags integrations, runtime
 */
function describeAnalyzeFailure(kind: AnalyzeFailureKind, detail?: string | number | null): string {
	switch (kind) {
		case "not-started":
			return "vp analyze could not be started";
		case "spawn-failed":
			return "vision-proxy could not be started";
		case "missing-cli":
			return "the vision-proxy CLI was not found";
		case "failed":
			return "vp analyze failed";
		case "failed-or-timed-out":
			return "vp analyze failed or timed out";
		case "exit-status":
			// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
			return "vp analyze exited with status " + (detail == null ? "?" : String(detail));
		case "timed-out":
			return "vp analyze timed out";
		case "aborted":
			return "vp analyze was aborted";
	}
}

function isImagePath(p: unknown): boolean {
	if (!p || typeof p !== "string") return false;
	var parts = p.split(".");
	var ext = (parts.pop() || "").toLowerCase();
	return ext !== "" && IMAGE_EXT.indexOf(ext) !== -1;
}

function resolveImagePath(p: string | undefined | null, cwd?: string): string | null {
	if (!p) return null;
	var home: string | undefined;
	// Expand a leading tilde: Node fs and spawn APIs do not expand it, so an
	// unexpanded path would fail existsSync guards and be silently dropped.
	// Honor process.env.HOME first so isolated or non-standard homes resolve.
	if (p === "~" || p.indexOf("~/") === 0) {
		home = process.env.HOME || homedir();
		if (home) return p === "~" ? home : join(home, p.slice(2));
	}
	if (p.charAt(0) === "/" || p.charAt(0) === "~" || /^[a-zA-Z]:[/\\]/.test(p)) return p;
	if (cwd && (p.indexOf("./") === 0 || p.indexOf("../") === 0)) {
		try {
			return resolve(cwd, p);
		} catch {
			return p;
		}
	}
	return p;
}

function extractImagePaths(text: string): string[] {
	// Two passes, both anchored to a delimiter (start-of-text or
	// whitespace/quote/bracket/comma/semicolon) so words like nota/path.jpeg
	// do not match: absolute-ish paths (drive letter, slash, or tilde prefix)
	// and relative paths starting with ./ or ../. Clipboard temp files such as
	// /tmp/pi-clipboard-<id>.png match the absolute pass with no special case.
	// Trailing prose punctuation is trimmed and values containing // are
	// rejected so URLs never match.
	var found: string[] = [];
	var seen: string[] = [];
	var add = (raw: string | undefined): void => {
		var t = (raw == null ? "" : raw).trim().replace(/[.,;:!?)\]}>'"]+$/, "");
		if (!t || t.indexOf("//") !== -1) return;
		if (seen.indexOf(t) !== -1) return;
		seen.push(t);
		found.push(t);
	};
	var D = "[\\s'\"()\\[\\],;]";
	// Keep spaces inside a candidate path. The non-greedy suffix stops at the
	// first recognized image extension, while quotes, wildcards, pipes, and
	// newlines remain hard boundaries for prose and shell-like input.
	var B = "[^'\"()*?|\\n]";
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var EXT = "(?:" + IMAGE_EXT.join("|") + ")";
	var reAbs = new RegExp(
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		"(^|" + D + ")((?:[a-zA-Z]:[/\\\\]|[/~])" + B + "*?\\." + EXT + ")\\b",
		"gi",
	);
	for (const m of text.matchAll(reAbs)) add(m[2]);
	// Also match paths without spaces so a non-image path cannot swallow a
	// later image path into one broad candidate.
	var BW = "[^'\\\"()*?|\\s]";
	var reAbsTight = new RegExp(
		// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
		"(^|" + D + ")((?:[a-zA-Z]:[/\\\\]|[/~])" + BW + "*?\\." + EXT + ")\\b",
		"gi",
	);
	for (const m of text.matchAll(reAbsTight)) add(m[2]);
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var reRel = new RegExp("(^|" + D + ")((?:\\.\\.?/)" + B + "*?\\." + EXT + ")\\b", "gi");
	for (const m of text.matchAll(reRel)) add(m[2]);
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var reRelTight = new RegExp("(^|" + D + ")((?:\\.\\.?/)" + BW + "*?\\." + EXT + ")\\b", "gi");
	for (const m of text.matchAll(reRelTight)) add(m[2]);
	return found;
}

function withImageInstruction(
	description: string,
	marker?: string,
	toolWord: string = "Read",
): string {
	// Hosts whose lifecycle re-fires (Pi context) pass the shared marker so the
	// injected text stays recognizable; single-fire hosts pass none and keep
	// their historical marker-free deny shape.
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var prefix = marker ? marker + " " : "";
	return (
		prefix +
		"Do not use the " +
		toolWord +
		" tool on image files. " +
		"vision-proxy has already routed the image(s) through a vision-input model " +
		"and produced the description below. " +
		"Treat that description as the image content. " +
		"If you need a more specific or detailed analysis, ask in the prompt instead of reading the file.\n\n" +
		description
	);
}

function readReminder(
	paths: string[],
	marker: string | undefined,
	subject: string,
	toolWord: string,
): string {
	// Pure string work, never shells out. Subject and tool wording stay
	// parameters so each host keeps its exact historical phrasing: the stdio
	// script reminds with prompt/Read while Pi uses message/read.
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var prefix = marker ? marker + " " : "";
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	var listed = paths.map((p) => "- " + p).join("\n");
	return (
		prefix +
		"The user " +
		subject +
		" references the following image file(s):\n" +
		listed +
		"\n\nUse the " +
		toolWord +
		" tool on each image path to inspect it. " +
		"vision-proxy intercepts image reads and supplies a vision-model description as context. " +
		"Do not answer about an image without reading it first."
	);
}

export {
	ANALYZE_STDIN_MARKER,
	ASSISTANT_TRUNCATE_CHARS,
	appendContextFileArg,
	buildAnalyzeArgs,
	buildConversationContext,
	CONTEXT_FILE_MAX_BYTES,
	CONTEXT_FILE_PREFIX,
	CONTEXT_FILE_TTL_MS,
	CONTEXT_MAX_CHARS,
	contextFileDir,
	DEFAULT_HOOK_TIMEOUT_MS,
	DEFAULT_MAX_OUTPUT_TOKENS,
	describeAnalyzeFailure,
	ensurePrivateContextDir,
	extractImagePaths,
	extractText,
	HOST_ENV,
	hookTimeoutMs,
	IMAGE_EXT,
	isAnalysisDisabled,
	isImagePath,
	isSafeContextDir,
	isUnflaggedAnalyzeCommand,
	MAX_BUFFER_BYTES,
	MAX_HOOK_TIMEOUT_MS,
	MAX_MAX_OUTPUT_TOKENS,
	MIN_HOOK_TIMEOUT_MS,
	MIN_MAX_OUTPUT_TOKENS,
	maxOutputTokens,
	PENDING_CONTEXT_FILE_NAME,
	PENDING_CONTEXT_TTL_MS,
	parsePositiveInt,
	pendingContextFilePath,
	pruneStaleContextFiles,
	quoteShellArg,
	RECENT_MESSAGE_COUNT,
	REMINDER_MARKER,
	readReminder,
	resolveHookTimeout,
	resolveImagePath,
	resolveMaxOutputTokens,
	resolveVpBin,
	truncateConversationContext,
	utf8ByteLength,
	vpEntryToSpawn,
	withImageInstruction,
	writeContextFile,
	writePendingContextFile,
};

function constLine(name: string, value: unknown): string {
	// biome-ignore lint/style/useTemplate: plain concatenation, no template syntax involved.
	return "var " + name + " = " + JSON.stringify(value) + ";";
}

/**
 * Central standalone-source constraint check, shared by the golden tests.
 * Every generated artifact (after version-marker rendering) must satisfy it:
 * no backtick and no dollar-sign-plus-brace (the sources are embedded with
 * String.raw, so either sequence would corrupt or interpolate the output),
 * and no import of the installed vision-proxy package (the artifacts must
 * run with no package present). Returns one entry per violation found.
 */
export function standaloneViolations(source: string): string[] {
	const violations: string[] = [];
	if (source.indexOf("`") !== -1) violations.push("contains a backtick");
	if (source.indexOf("${") !== -1) violations.push("contains ${");
	if (/from\s+["']vision-proxy["']/.test(source))
		violations.push("imports the vision-proxy package");
	if (/require\(\s*["']vision-proxy["']\s*\)/.test(source)) {
		violations.push("requires the vision-proxy package");
	}
	return violations;
}

/**
 * Standalone source string inlined into each emitted host file at generate()
 * time. Composed from the canonical functions above via toString, so the
 * tested implementation and the shipped source cannot drift, plus constant
 * declarations rendered from the same values.
 */
export const HOOK_RUNTIME_SOURCE: string = [
	constLine("IMAGE_EXT", IMAGE_EXT),
	constLine("REMINDER_MARKER", REMINDER_MARKER),
	constLine("DEFAULT_HOOK_TIMEOUT_MS", DEFAULT_HOOK_TIMEOUT_MS),
	constLine("MIN_HOOK_TIMEOUT_MS", MIN_HOOK_TIMEOUT_MS),
	constLine("MAX_HOOK_TIMEOUT_MS", MAX_HOOK_TIMEOUT_MS),
	constLine("DEFAULT_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
	constLine("MIN_MAX_OUTPUT_TOKENS", MIN_MAX_OUTPUT_TOKENS),
	constLine("MAX_MAX_OUTPUT_TOKENS", MAX_MAX_OUTPUT_TOKENS),
	constLine("MAX_BUFFER_BYTES", MAX_BUFFER_BYTES),
	constLine("DEFAULT_VP_BIN", "vp"),
	// biome-ignore lint/style/useTemplate: concatenation keeps the shipped source free of backticks and interpolation sequences.
	"var HOST_ENV = " + JSON.stringify(HOST_ENV) + ";",
	constLine("ANALYZE_STDIN_MARKER", ANALYZE_STDIN_MARKER),
	constLine("RECENT_MESSAGE_COUNT", RECENT_MESSAGE_COUNT),
	constLine("ASSISTANT_TRUNCATE_CHARS", ASSISTANT_TRUNCATE_CHARS),
	constLine("CONTEXT_MAX_CHARS", CONTEXT_MAX_CHARS),
	constLine("CONTEXT_FILE_PREFIX", CONTEXT_FILE_PREFIX),
	constLine("CONTEXT_FILE_TTL_MS", CONTEXT_FILE_TTL_MS),
	constLine("PENDING_CONTEXT_FILE_NAME", PENDING_CONTEXT_FILE_NAME),
	constLine("PENDING_CONTEXT_TTL_MS", PENDING_CONTEXT_TTL_MS),
	constLine("CONTEXT_FILE_MAX_BYTES", CONTEXT_FILE_MAX_BYTES),
	parsePositiveInt.toString(),
	hookTimeoutMs.toString(),
	maxOutputTokens.toString(),
	isAnalysisDisabled.toString(),
	resolveHookTimeout.toString(),
	resolveMaxOutputTokens.toString(),
	vpEntryToSpawn.toString(),
	resolveVpBin.toString(),
	buildAnalyzeArgs.toString(),
	describeAnalyzeFailure.toString(),
	isUnflaggedAnalyzeCommand.toString(),
	appendContextFileArg.toString(),
	contextFileDir.toString(),
	isSafeContextDir.toString(),
	ensurePrivateContextDir.toString(),
	pruneStaleContextFiles.toString(),
	pendingContextFilePath.toString(),
	writePendingContextFile.toString(),
	writeContextFile.toString(),
	utf8ByteLength.toString(),
	isTextBlock.toString(),
	extractText.toString(),
	truncateConversationContext.toString(),
	buildConversationContext.toString(),
	isImagePath.toString(),
	resolveImagePath.toString(),
	extractImagePaths.toString(),
	withImageInstruction.toString(),
	readReminder.toString(),
	quoteShellArg.toString(),
].join("\n\n");
