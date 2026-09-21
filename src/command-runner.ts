/**
 * Command runner for the `vp` / `vision-proxy` CLI.
 *
 * Owns the command grammar and dispatch policy extracted from `src/cli.ts`:
 * hand-rolled flag parsing, help lookup/rendering, subcommand routing, and
 * result/error mapping. `src/cli.ts` stays the process adapter (argv,
 * stdout/stderr, exit behavior, update-notifier setup) and delegates here.
 *
 * The runner is side-effect free except through the command modules it calls:
 * it returns a structured `{ stdout, stderr, code }` outcome and never touches
 * `process.stdout`, `process.stderr`, or `process.exitCode` itself, so seam
 * tests can pin routing without capturing process streams.
 */

import { AnalyzeError, type AnalyzeFlags, parseCropFlags, runAnalyze } from "./commands/analyze.ts";
import { cacheClearCmd, cachePruneCmd, cacheStatus } from "./commands/cache.ts";
import { configGet, configInit, configSet, configValidate } from "./commands/config.ts";
import { runIntegration } from "./commands/integration.ts";
import {
	providerCheck,
	providerDeleteKey,
	providerList,
	providerListKeys,
	providerStoreKey,
} from "./commands/provider.ts";
import { runBackgroundCheck, runUpdate } from "./commands/update.ts";
import { loadConfig } from "./config.ts";
import type { GroundingFormat } from "./core.ts";
import { ANALYZE_STDIN_MARKER } from "./integrations/runtime.ts";
import { isKnownProvider } from "./provider.ts";
import { VERSION } from "./version.ts";

export interface FlagParse {
	flags: Record<string, string | boolean | string[]>;
	positionals: string[];
	error?: string;
}

function collectFlag(
	flags: Record<string, string | boolean | string[]>,
	key: string,
	value: string | boolean,
): void {
	const existing = flags[key];
	if (existing === undefined) {
		flags[key] = value;
		return;
	}
	if (Array.isArray(existing)) {
		existing.push(value as string);
	} else {
		flags[key] = [existing as string, value as string];
	}
}

/**
 * Flags that consume a following value (e.g. `--format qwen_pixels`,
 * `--crop i:form`, `-q "what?"`). Every other `--flag` / `-x` is boolean and
 * must NOT consume the next positional argument, otherwise a boolean flag
 * placed before a positional (e.g. `vp analyze --json "image.png"`) would
 * swallow the positional as its value and leave the command with no inputs.
 *
 * @tags cli, runner
 */
export const VALUE_FLAGS = new Set([
	"format",
	"provider",
	"model",
	"config",
	"max-output-tokens",
	"question",
	"q",
	"context",
	"api-key",
	"apiKey",
	"older",
	"crop",
	"version",
]);

/**
 * Parse `--flag` / `-x` tokens into a flag map plus positionals.
 *
 * @tags cli, runner
 */
export function parseFlags(args: string[]): FlagParse {
	const flags: Record<string, string | boolean | string[]> = {};
	const positionals: string[] = [];
	let error: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq >= 0) {
				collectFlag(flags, a.slice(2, eq), a.slice(eq + 1));
			} else if (a === "--no-fence") {
				flags.fence = false;
			} else if (a === "--no-context") {
				flags["no-context"] = true;
			} else {
				const name = a.slice(2);
				const next = args[i + 1];
				if (VALUE_FLAGS.has(name)) {
					if (next === undefined || next.startsWith("--")) {
						error ??= `missing value for --${name}`;
					} else {
						collectFlag(flags, name, next);
						i++;
					}
				} else {
					collectFlag(flags, name, true);
				}
			}
		} else if (a.startsWith("-") && a.length > 1) {
			// single-dash flags: -m, -q, -c=...
			const body = a.slice(1);
			const eq = body.indexOf("=");
			if (eq >= 0) {
				collectFlag(flags, body.slice(0, eq), body.slice(eq + 1));
			} else {
				const next = args[i + 1];
				if (VALUE_FLAGS.has(body)) {
					if (next === undefined || next.startsWith("-")) {
						error ??= `missing value for -${body}`;
					} else {
						collectFlag(flags, body, next);
						i++;
					}
				} else {
					collectFlag(flags, body, true);
				}
			}
		} else {
			positionals.push(a);
		}
	}
	return { flags, positionals, error };
}

type FlagMap = Record<string, string | boolean | string[]>;

/**
 * Sensitive analyze inputs carried on stdin instead of argv (CWE-214).
 *
 * `vp analyze` accepts its question/context through a JSON stdin payload so
 * conversation text never appears in the process listing:
 *
 *   <marker line>\n{"question": "...", "context": "..."}
 *
 * The marker line distinguishes the payload from `provider store-key` key
 * bytes. Only the analyze path reads stdin this way; every other command is
 * unaffected. Malformed payloads fail closed to no question/context.
 *
 * @tags cli, runner
 */
export interface AnalyzeStdinPayload {
	question?: string;
	context?: string;
}

/**
 * Decode one analyze stdin payload. Pure and total: empty, truncated, or
 * malformed input yields {} so the caller treats it as "no sensitive
 * input" rather than failing the analysis.
 *
 * @tags cli, runner
 */
export function parseAnalyzeStdin(raw: string): AnalyzeStdinPayload {
	const text = raw ?? "";
	const nl = text.indexOf("\n");
	if (nl === -1) return {};
	if (text.slice(0, nl).trim() !== ANALYZE_STDIN_MARKER) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(nl + 1));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const rec = parsed as Record<string, unknown>;
	const out: AnalyzeStdinPayload = {};
	if (typeof rec.question === "string" && rec.question.trim()) out.question = rec.question;
	if (typeof rec.context === "string" && rec.context.trim()) out.context = rec.context;
	return out;
}

/** Bounded wait (ms) for the `vp analyze` process-stdin drain. */
const DEFAULT_ANALYZE_STDIN_TIMEOUT_MS = 50;

/**
 * Default stdin reader for `vp analyze`. Skips TTYs so an interactive
 * terminal never blocks waiting for a payload; callers pass an explicit
 * reader in tests and adapters pass the payload through child stdio.
 *
 * The wait is bounded (default 50ms): `vp analyze` historically never
 * touched stdin, so an open pipe that never reaches EOF (CI/a wrapper
 * inheriting stdin without writing or closing it) degrades to "" instead
 * of hanging the command. Adapters are unaffected: they write a small
 * payload and close child stdin right after spawning, so the
 * drain resolves on arrival, well before the timeout. Expiry detaches the
 * listeners and pauses stdin so no background read keeps the event loop
 * alive after the command finishes.
 *
 * A timeout after partial data is diagnosed on stderr (stdout stays clean
 * for `--json` consumers): without it a slow-arriving adapter payload
 * would silently degrade to a context-free analysis.
 *
 * Stream errors (EPIPE/EIO on a broken pipe) likewise degrade to "" so a
 * stdin failure can never surface as a crash; the analysis simply runs
 * without the sensitive payload.
 *
 * @tags cli, runner
 */
export async function readAnalyzeStdin(
	timeoutMs = DEFAULT_ANALYZE_STDIN_TIMEOUT_MS,
): Promise<string> {
	try {
		const { stdin } = process;
		if (!stdin || stdin.isTTY) return "";
		return await new Promise<string>((resolve) => {
			const chunks: Buffer[] = [];
			let settled = false;
			const onData = (c: Buffer): void => {
				chunks.push(c);
			};
			const finish = (val: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					stdin.pause();
				} catch {
					// ignore: stdin may already be torn down
				}
				stdin.removeListener("data", onData);
				stdin.removeListener("end", onEnd);
				stdin.removeListener("error", onError);
				resolve(val);
			};
			const onEnd = (): void => {
				finish(Buffer.concat(chunks).toString("utf8"));
			};
			const onError = (): void => {
				finish("");
			};
			const onTimeout = (): void => {
				// Timeouts are only silent when nothing arrived at all (the
				// historical no-stdin case). Partial data means an adapter
				// payload was cut off: say so on stderr so the context-free
				// fallback is diagnosable, while stdout stays machine-clean.
				if (chunks.length > 0) {
					try {
						process.stderr.write(
							"[vision-proxy] analyze stdin payload incomplete after " +
								`${timeoutMs}ms; continuing without question/context\n`,
						);
					} catch {
						// ignore: stderr may be torn down in tests
					}
				}
				finish("");
			};
			const timer = setTimeout(onTimeout, timeoutMs);
			stdin.on("data", onData);
			stdin.on("end", onEnd);
			stdin.on("error", onError);
		});
	} catch {
		return "";
	}
}

/**
 * Resolve the analyze stdin text.
 *
 * An explicit `stdinText` override (tests) or `readStdin` (dependency-
 * injected readers) wins immediately. Otherwise the bounded process-stdin
 * drain runs: adapter payloads resolve on arrival; a pipe that never
 * delivers degrades to "no payload" on timeout instead of hanging a
 * command that historically never touched stdin.
 *
 * @tags cli, runner
 */
async function drainAnalyzeStdin(opts: CommandRunnerOptions): Promise<string> {
	if (opts.stdinText !== undefined) return opts.stdinText;
	if (opts.readStdin) {
		try {
			return await opts.readStdin();
		} catch {
			return "";
		}
	}
	const timeoutMs =
		typeof opts.stdinTimeoutMs === "number" && opts.stdinTimeoutMs >= 0
			? opts.stdinTimeoutMs
			: DEFAULT_ANALYZE_STDIN_TIMEOUT_MS;
	try {
		return await readAnalyzeStdin(timeoutMs);
	} catch {
		return "";
	}
}

function str(flags: FlagMap, key: string): string | undefined {
	const v = flags[key];
	return typeof v === "string" ? v : undefined;
}

function bool(flags: FlagMap, key: string, dflt: boolean): boolean {
	if (!(key in flags)) return dflt;
	const v = flags[key];
	return v === true || v === "true" || v === "1" || v === "on";
}

/** True when a `--help`/`-h` flag or a literal "help"/"-h"/"--help" token appears. */
function wantsHelp(flags: FlagMap, tokens: string[]): boolean {
	if (bool(flags, "help", false) || bool(flags, "h", false)) return true;
	return tokens.includes("help") || tokens.includes("-h") || tokens.includes("--help");
}

/**
 * Top-level help text. Byte-for-byte identical to the historical `cli.ts` HELP.
 *
 * @tags cli, runner
 */
export const HELP = `vision-proxy (vp) ${VERSION}

Usage:
  vp analyze <paths...> [options]
  vp config <init|get|set|validate> ...
  vp provider <list|check|store-key|delete-key|list-keys> ...
  vp cache <status|clear|prune> ...
  vp update [--check] [--version <tag>] [--force] [--beta]

analyze options:
  --format <name>    plain | qwen_pixels | molmo_points | deepseek_bbox | internvl_pixels | gemini_normalized_1000
  --provider <name>  override provider
  --model <id>       override model
  --joint            joint multi-image batch
  --crop <i:form>    crop before analysis (repeatable)
  --no-fence         drop <vision_proxy_description> fence (debug only)
  --config <path>    config override
  --json             machine-readable output
  --max-output-tokens <n>  cap response tokens
  --question <text>  text to analyze against the image
  --context <text>   recent conversation context for the analysis
  --no-context       drop conversation context for this call only
  --api-key <key>    explicit provider key

config options:
  init                       scaffold .vision-proxy.json in cwd
  get [--config <path>]      print resolved config
  set <key> <value>          set a key in .vision-proxy.json
  validate [--config <path>] check config + provider reachability

provider options:
  list                       list providers + key presence
  check [<name>]             verify auth
  store-key <name>           read key from stdin, store in system keyring
  delete-key <name>          delete key from the system keyring
  list-keys                  list providers with keyring-stored keys

cache options:
  status                     hit rate + size
  clear                      drop all entries
  prune [--older <days>]     evict entries older than N days (default 30)

update options:
  --check, -c                check for updates without modifying files
  --version <tag>            install a specific release tag (e.g. v0.1.0)
  --force, -f                reinstall even when already up to date
  --beta                     install the latest pre-release instead of stable

integration options:
  install <agent>            install vision-proxy for pi | claude-code | codex | opencode
  show <agent>               print what install would generate
  list                       show which agents have vision-proxy installed
  status                     show installed version markers per agent
  uninstall <agent>          remove the integration
`;

/**
 * Per-subcommand help blocks. Keyed by the command path (e.g. "config" or
 * "config init"). `renderHelp` resolves the most specific block, falling back
 * to the parent command, then the top-level HELP.
 */
const HELP_INDEX: Record<string, string> = {
	analyze: `vp analyze <paths...> [options]

Analyze one or more images with a vision model and print a fenced,
UNTRUSTED description.

Usage:
  vp analyze <paths...> [options]

Arguments:
  <paths...>           one or more image file paths or URLs (http/https) to analyze

Options:
  --format <name>      grounding format: plain (default) | qwen_pixels |
                       molmo_points | deepseek_bbox | internvl_pixels |
                       gemini_normalized_1000
  --provider <name>    override the configured provider (openai, anthropic,
                       or google)
  --model <id>         override the configured model id
  --joint              force a joint multi-image batch
  --crop <i:form>      crop image <index> before analysis (repeatable),
                       e.g. 0:0.1,0.1,0.5,0.5
  --no-fence           drop the <vision_proxy_description> fence (debug only)
  --config <path>      use an explicit config file
  --json               emit machine-readable JSON to stdout
  --max-output-tokens <n>  cap the model response tokens
  --question <text>    text to analyze against the image (-q)
  --context <text>     recent conversation context for the analysis
  --no-context         drop conversation context for this call only
  --api-key <key>      explicit provider API key (-apiKey)
  -h, --help           show this help

Notes:
  The description fence is ON by default. Image-derived text is
  attacker-controlled, so only use --no-fence for local debugging.`,

	config: `vp config <subcommand> [options]

Manage the VisionConfig (.vision-proxy.json).

Usage:
  vp config init [--config <path>]       scaffold a config in the cwd
  vp config get  [--config <path>]       print the resolved config
  vp config set  <key> <value>           set a key in the project config
  vp config validate [--config <path>]   check config + provider reachability

Subcommands:
  init               scaffold .vision-proxy.json in the current directory
  get                print the resolved config with precedence notes
  set <key> <value>  set a key in the project config
  validate           validate config + probe provider auth

Options:
  --config <path>    explicit config file path (get/set/validate)
  -h, --help         show this help`,

	"config init": `vp config init

Scaffold a .vision-proxy.json in the current directory.

Usage:
  vp config init

Notes:
  Fails if a .vision-proxy.json already exists in the cwd.`,

	"config get": `vp config get [--config <path>]

Print the resolved config (with precedence notes).

Usage:
  vp config get [--config <path>]

Options:
  --config <path>    explicit config file path
  -h, --help         show this help`,

	"config set": `vp config set <key> <value>

Set a key in the project .vision-proxy.json.

Usage:
  vp config set <key> <value>

Arguments:
  <key>              a known config key (provider, modelId, mode, ...)
  <value>            value to set (coerced to the key's type)

Notes:
  Unknown keys are rejected. Run \`vp config get\` to see the current keys.`,

	"config validate": `vp config validate [--config <path>]

Validate config and probe provider reachability.

Usage:
  vp config validate [--config <path>]

Options:
  --config <path>    explicit config file path
  -h, --help         show this help`,

	provider: `vp provider <subcommand> [options]

Manage the provider registry and credentials.

Usage:
  vp provider list                       list providers + key presence
  vp provider check [<name>]             verify provider auth
  vp provider store-key <name>           read key from stdin -> keyring
  vp provider delete-key <name>          delete key from keyring
  vp provider list-keys                  list keyring-stored keys

Subcommands:
  list                list configured providers and key presence
  check [<name>]      verify API key is configured (all if omitted)
  store-key <name>    read a key from stdin, store in the system keyring
  delete-key <name>   delete a provider's keyring-stored key
  list-keys           list providers with a keyring-stored key

Notes:
  Credentials come from an env var (e.g. ANTHROPIC_API_KEY) or the system
  keyring. Supply the key via the env var or \`vp provider store-key <name>\`.
  Set the active provider with \`vp config set provider <name>\`.
`,

	"provider list": `vp provider list

List configured providers and key presence.

Usage:
  vp provider list

For each known provider, shows its id, label, image support, and whether
a key is present (env var or keyring).`,

	"provider check": `vp provider check [<name>]

Verify that an API key is configured for a provider.

Usage:
  vp provider check [<name>]

Arguments:
  <name>              provider id to check (all providers if omitted)

Exits non-zero if any checked provider is missing a key.`,

	"provider store-key": `vp provider store-key <name>

Read a provider API key from stdin and store it in the system keyring.

Usage:
  vp provider store-key <name>

Arguments:
  <name>              a known provider id

Example:
  echo -n "$KEY" | vp provider store-key anthropic

The key is read from stdin so it never lands in shell history or process
listings.`,

	"provider delete-key": `vp provider delete-key <name>

Delete a provider's API key from the system keyring.

Usage:
  vp provider delete-key <name>

Arguments:
  <name>              a known provider id`,

	"provider list-keys": `vp provider list-keys

List providers that have a key stored in the system keyring.

Usage:
  vp provider list-keys`,

	cache: `vp cache <subcommand> [options]

Inspect and manage the pHash / description cache.

Usage:
  vp cache status                  show hit rate, size, and path
  vp cache clear                   drop all cached entries
  vp cache prune [--older <days>]  evict entries older than N days

Subcommands:
  status             show hit rate, entry count, and cache path
  clear              drop all cached entries
  prune [--older]    evict entries older than N days (default 30)`,

	"cache status": `vp cache status

Show cache hit rate, size, and path.

Usage:
  vp cache status`,

	"cache clear": `vp cache clear

Drop all cached entries.

Usage:
  vp cache clear`,

	"cache prune": `vp cache prune [--older <days>]

Evict cache entries older than N days.

Usage:
  vp cache prune [--older <days>]

Options:
  --older <days>     age threshold in days (default 30)

Entries are removed by content age, not last access.`,

	integration: `vp integration <subcommand> [agent]

Install, inspect, list, or remove the vision-proxy integration for an agent.

Usage:
  vp integration install <agent>    install the integration
  vp integration show <agent>       print the hook command, script, and merged config
  vp integration list               show which agents have vision-proxy installed
  vp integration status             show installed version markers per agent
  vp integration uninstall <agent>  remove the integration

Subcommands:
  install <agent>    write the integration into the agent's config dir (--dev uses this CLI)
  show <agent>       print the hook command, script source, and merged config
  list               show installed agents
  status             show installed version markers per agent
  uninstall <agent>  remove the hook script and registrations

Agents:
  pi                 Pi coding agent (global extensions directory)
  claude-code        Claude Code agent (npx tsx hook script + hooks)
  codex              Codex agent (npx tsx hook script + hooks)
  opencode           opencode v1 agent (local TypeScript plugin)

Options:
  -h, --help         show this help`,

	"integration install": `vp integration install <agent> [--dev]

Install the vision-proxy integration for an agent.

Usage:
  vp integration install <agent> [--dev]

Arguments:
  <agent>            supported agent id: pi | claude-code | codex | opencode

Options:
  --dev              default generated artifacts to this CLI entry point`,

	"integration show": `vp integration show <agent>

Print the hook command, generated script source, and merged config for manual review.

Usage:
  vp integration show <agent>

Arguments:
  <agent>            supported agent id: pi | claude-code | codex | opencode`,

	"integration uninstall": `vp integration uninstall <agent>

Remove the vision-proxy integration for an agent.

Usage:
  vp integration uninstall <agent>

Arguments:
  <agent>            supported agent id: pi | claude-code | codex | opencode`,

	"integration list": `vp integration list

Show which agents have vision-proxy installed.

Usage:
  vp integration list

Output:
  one line per supported agent, prefixed with ✓ when installed
  (i.e. the installed agents list)`,

	"integration status": `vp integration status

Show installed version markers per agent.

Usage:
  vp integration status

Output:
  one line per supported agent with its install state and the version
  marker embedded in the installed artifact. Outdated integrations are
  flagged with a refresh hint.`,

	update: `vp update [--check] [--version <tag>] [--force] [--beta]

Self-update vision-proxy, or print package-manager guidance.

Usage:
  vp update                        check for a newer release and install it
  vp update --check (-c)           report only; never modify files
  vp update --version <tag>        install a specific release tag (e.g. v0.1.0)
  vp update --force (-f)           reinstall even when already up to date
  vp update --beta                 install the latest pre-release instead of stable

Options:
  --check, -c         check for updates without modifying files
  --version <tag>     install a specific release tag (e.g. v0.1.0)
  --force, -f         reinstall even when already up to date
  --beta              install the latest pre-release instead of stable
  -h, --help          show this help

Notes:
  The curl installer (~/.local/share/vision-proxy) is updated in place.
  Homebrew, npm, and source builds are detected and the appropriate update
  command is printed instead of performing an install.

  vp also prints a one-line notice on stderr when a cached release check
  finds a newer version. Set VP_NO_UPDATE_NOTIFIER=1 to disable it.`,
};

/**
 * Resolve help text for a command path. Falls back from the most specific
 * path (e.g. "config set") to its parent ("config") to the top-level HELP.
 *
 * @tags cli, runner
 */
export function renderHelp(path: string[]): string {
	const full = path.join(" ");
	if (HELP_INDEX[full]) return HELP_INDEX[full]!;
	if (path.length > 1) {
		const parent = path.slice(0, -1).join(" ");
		if (HELP_INDEX[parent]) return HELP_INDEX[parent]!;
	}
	return HELP;
}

export interface CommandRunnerOptions {
	/** Environment overrides (`VP_*`, provider keys). Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Working directory for project config resolution. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Stdin text override for `analyze` (tests inject the payload; the CLI reads process stdin). */
	stdinText?: string;
	/** Stdin reader override for `analyze` (defaults to the bounded process-stdin drain). */
	readStdin?: () => Promise<string>;
	/** Bound in ms for the `analyze` process-stdin drain (tests shorten it; default 50). */
	stdinTimeoutMs?: number;
}

export interface CommandRunnerResult {
	/** Line for stdout (without trailing newline; the adapter adds it). */
	stdout?: string;
	/** Line for stderr (without trailing newline; the adapter adds it). */
	stderr?: string;
	/** Process exit code implied by the outcome. */
	code: number;
}

function ok(stdout: string): CommandRunnerResult {
	return { stdout, code: 0 };
}

function err(stderr: string, code = 1): CommandRunnerResult {
	return { stderr, code };
}

function fromStatus(r: { ok: boolean; message: string; code: number }): CommandRunnerResult {
	return r.ok ? ok(r.message) : err(r.message, r.code);
}

/**
 * Run the CLI command grammar against `argv` (without the binary name).
 *
 * Covers every `vp` subcommand the historical `main()` handled: `analyze`,
 * `config`, `provider`, `cache`, `integration`, `update`, plus `version` and
 * `help`. Help/version resolve before dispatch; unknown commands and missing
 * positionals return exit-code-1 stderr outcomes with the historical wording.
 * The internal `update --background-check` worker runs silently (no output).
 *
 * @tags cli, runner
 */
export async function runCommand(
	argv: string[],
	opts: CommandRunnerOptions = {},
): Promise<CommandRunnerResult> {
	const [command, ...rest] = argv;
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();

	if (!command || command === "help" || command === "-h" || command === "--help") {
		return ok(HELP);
	}
	if (command === "version" || command === "--version" || command === "-v") {
		return ok(VERSION);
	}
	const parsed = parseFlags(rest);
	if (parsed.error) return err(parsed.error);
	const { flags, positionals } = parsed;

	switch (command) {
		case "analyze": {
			if (wantsHelp(flags, positionals)) {
				return ok(renderHelp(["analyze"]));
			}
			const { crops } = parseCropFlags(flags);
			const images = positionals.filter((a) => !a.startsWith("-"));
			if (images.length === 0) {
				return err("analyze requires at least one image path");
			}
			const formatRaw = str(flags, "format");
			const format =
				formatRaw && formatRaw !== "plain" ? (formatRaw as GroundingFormat) : undefined;
			const stdinText = await drainAnalyzeStdin(opts);
			const stdinPayload = parseAnalyzeStdin(stdinText);
			const analyzeFlags: AnalyzeFlags = {
				format,
				provider: str(flags, "provider"),
				model: str(flags, "model"),
				joint: bool(flags, "joint", false),
				crops,
				fence: bool(flags, "fence", true),
				configPath: str(flags, "config"),
				json: bool(flags, "json", false),
				maxOutputTokens: str(flags, "max-output-tokens")
					? Number(str(flags, "max-output-tokens"))
					: undefined,
				// Stdin is authoritative when present: adapters now send
				// sensitive text off-argv. Keep the argv flags as a fallback
				// for older wrappers that still pass --question/--context.
				// --no-context drops context only (question is opt-in per
				// call, so there is nothing to suppress): privacy/cost escape
				// hatch for one invocation without touching config.
				question: stdinPayload.question ?? str(flags, "question") ?? str(flags, "q"),
				context: bool(flags, "no-context", false)
					? undefined
					: (stdinPayload.context ?? str(flags, "context")),
				apiKey: str(flags, "api-key") ?? str(flags, "apiKey"),
				env,
			};
			try {
				const outcome = await runAnalyze(images, analyzeFlags);
				if (analyzeFlags.json) {
					return ok(
						JSON.stringify({ cacheHit: outcome.cacheHit, records: outcome.records }, null, 2),
					);
				}
				return ok(outcome.output);
			} catch (e) {
				if (e instanceof AnalyzeError) {
					return err(`analyze error: ${e.message}`);
				}
				return err(`analyze failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		case "config": {
			const [sub, ...subRest] = positionals;
			if (wantsHelp(flags, [sub ?? ""])) {
				return ok(renderHelp(["config", sub ?? ""].filter(Boolean) as string[]));
			}
			switch (sub) {
				case "init":
					return fromStatus(await configInit(cwd));
				case "get":
					return fromStatus(await configGet({ configPath: str(flags, "config"), cwd, env }));
				case "set": {
					const key = subRest[0];
					const value = subRest[1];
					if (!key || value === undefined) {
						return err("usage: vp config set <key> <value>");
					}
					return fromStatus(await configSet(key, value, cwd));
				}
				case "validate":
					return fromStatus(
						await configValidate({
							configPath: str(flags, "config"),
							cwd,
							env,
						}),
					);
				default:
					return err(`unknown config subcommand "${sub ?? ""}". Try: init, get, set, validate`);
			}
		}

		case "provider": {
			const [sub, ...subRest] = positionals;
			if (wantsHelp(flags, [sub ?? ""])) {
				return ok(renderHelp(["provider", sub ?? ""].filter(Boolean) as string[]));
			}
			switch (sub) {
				case "list": {
					const { config } = await loadConfig({ cwd, env });
					return fromStatus(providerList(env, config));
				}
				case "check": {
					const { config } = await loadConfig({ cwd, env });
					return fromStatus(providerCheck(subRest[0], env, config));
				}
				case "store-key": {
					const name = subRest[0];
					if (!name) {
						return err("usage: vp provider store-key <name>");
					}
					return fromStatus(await providerStoreKey(name));
				}
				case "delete-key": {
					const name = subRest[0];
					if (!name) {
						return err("usage: vp provider delete-key <name>");
					}
					return fromStatus(providerDeleteKey(name));
				}
				case "list-keys":
					return fromStatus(providerListKeys());
				default:
					return err(
						`unknown provider subcommand "${sub ?? ""}". Try: list, check, store-key, delete-key, list-keys`,
					);
			}
		}

		case "cache": {
			const [sub] = positionals;
			if (wantsHelp(flags, [sub ?? ""])) {
				return ok(renderHelp(["cache", sub ?? ""].filter(Boolean) as string[]));
			}
			switch (sub) {
				case "status":
					return fromStatus(await cacheStatus());
				case "clear":
					return fromStatus(await cacheClearCmd());
				case "prune":
					return fromStatus(
						await cachePruneCmd(str(flags, "older") ? Number(str(flags, "older")) : undefined),
					);
				default:
					return err(`unknown cache subcommand "${sub ?? ""}". Try: status, clear, prune`);
			}
		}

		case "integration": {
			const [sub, ...subRest] = positionals;
			if (wantsHelp(flags, [sub ?? ""])) {
				return ok(renderHelp(["integration", sub ?? ""].filter(Boolean) as string[]));
			}
			const agent = subRest[0];
			return fromStatus(
				await runIntegration(sub ?? "", agent ?? "", undefined, bool(flags, "dev", false)),
			);
		}

		case "update": {
			if (wantsHelp(flags, rest)) {
				return ok(renderHelp(["update"]));
			}
			// Internal: refresh the notifier cache. Spawned detached, emits nothing.
			if (bool(flags, "background-check", false)) {
				await runBackgroundCheck({ env });
				return { code: 0 };
			}
			const result = await runUpdate({
				check: bool(flags, "check", false) || bool(flags, "c", false),
				version: str(flags, "version"),
				force: bool(flags, "force", false) || bool(flags, "f", false),
				beta: bool(flags, "beta", false),
			});
			return fromStatus(result);
		}

		default:
			if (isKnownProvider(command)) {
				return err(`"${command}" is a provider, not a command. Did you mean "vp analyze"?`);
			}
			return err(`unknown command "${command}". Run "vp help".`);
	}
}
