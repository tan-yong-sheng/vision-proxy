#!/usr/bin/env node
import { basename } from "node:path";
/**
 * vision-proxy / vp CLI entry point.
 *
 * Command tree:
 *   analyze <paths...> [--format] [--provider] [--model] [--joint] [--crop i:form]
 *                     [--no-fence] [--config] [--json] [--max-output-tokens] [--question] [--api-key]
 *   config   init | get | set <k> <v> | validate
 *   provider list | check [<name>] | store-key <name> | delete-key <name> | list-keys
 *   cache    status | clear | prune [--older <days>]
 *   integration install | show | list | status | uninstall <agent>
 *   version | help
 */
import { AnalyzeError, type AnalyzeFlags, parseCropFlags, runAnalyze } from "./commands/analyze.ts";
import { cacheClearCmd, cachePruneCmd, cacheStatus } from "./commands/cache.ts";
import { configGet, configInit, configSet, configValidate } from "./commands/config.ts";
import { readEvent, runHook } from "./commands/hook.ts";
import { runIntegration } from "./commands/integration.ts";
import {
	providerCheck,
	providerDeleteKey,
	providerList,
	providerListKeys,
	providerStoreKey,
} from "./commands/provider.ts";
import { loadConfig } from "./config.ts";
import type { GroundingFormat } from "./core.ts";
import { isKnownProvider } from "./provider.ts";
import { VERSION } from "./version.ts";

interface FlagParse {
	flags: Record<string, string | boolean | string[]>;
	positionals: string[];
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
 */
const VALUE_FLAGS = new Set([
	"format",
	"provider",
	"model",
	"config",
	"max-output-tokens",
	"question",
	"q",
	"api-key",
	"apiKey",
	"older",
	"crop",
]);

export function parseFlags(args: string[]): FlagParse {
	const flags: Record<string, string | boolean | string[]> = {};
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq >= 0) {
				collectFlag(flags, a.slice(2, eq), a.slice(eq + 1));
			} else if (a === "--no-fence") {
				flags.fence = false;
			} else {
				const name = a.slice(2);
				const next = args[i + 1];
				if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
					collectFlag(flags, name, next);
					i++;
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
				if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith("-")) {
					collectFlag(flags, body, next);
					i++;
				} else {
					collectFlag(flags, body, true);
				}
			}
		} else {
			positionals.push(a);
		}
	}
	return { flags, positionals };
}

type FlagMap = Record<string, string | boolean | string[]>;
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

const HELP = `vision-proxy (vp) ${VERSION}

Usage:
  vp analyze <paths...> [options]
  vp config <init|get|set|validate> ...
  vp provider <list|check|store-key|delete-key|list-keys> ...
  vp cache <status|clear|prune> ...

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

integration options:
  install <agent>            install vision-proxy for pi | claude-code | codex
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
  vp integration show <agent>       print the generated extension source
  vp integration list               show which agents have vision-proxy installed
  vp integration status             show installed version markers per agent
  vp integration uninstall <agent>  remove the integration

Subcommands:
  install <agent>    write the integration into the agent's extensions dir
  show <agent>       print the generated extension source for review
  list               show installed agents
  status             show installed version markers per agent
  uninstall <agent>  remove the generated extension file

Agents:
  pi                 Pi coding agent (global extensions directory)
  claude-code        Claude Code agent (UserPromptSubmit hook)
  codex              Codex agent (UserPromptSubmit hook)

Options:
  -h, --help         show this help`,

	"integration install": `vp integration install <agent>

Install the vision-proxy integration for an agent.

Usage:
  vp integration install <agent>

Arguments:
  <agent>            supported agent id (currently: pi)`,

	"integration show": `vp integration show <agent>

Print the generated extension source for manual review.

Usage:
  vp integration show <agent>

Arguments:
  <agent>            supported agent id (currently: pi)`,

	"integration uninstall": `vp integration uninstall <agent>

Remove the vision-proxy integration for an agent.

Usage:
  vp integration uninstall <agent>

Arguments:
  <agent>            supported agent id (currently: pi)`,

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

	hook: `vp hook

Agent hook dispatcher. Read a hook event JSON from stdin and emit
hookSpecificOutput.additionalContext with an image description.

Events:
  UserPromptSubmit   image paths and [Image #N] refs in the prompt are analyzed
  PreToolUse Read    an image file_path read by the Read tool is analyzed

In a UserPromptSubmit event, Claude Code represents pasted or attached images
as '[Image #N]' references while storing the actual file under
'<CLAUDE_CONFIG_DIR | ~/.claude>/image-cache/<session>/<N>.<ext>'. vp hook
resolves those refs to file paths (using the session_id from the event) so the
images are analyzed too. Override the config home with VP_CLAUDE_CONFIG_DIR.

Usage:
  vp hook < event.json

The agent invokes this command directly as its hook. It reads the event from
stdin, and on a recognized image event runs 'vp analyze' and prints the
fenced description as additional context. On any error it exits 0 with no
output (fail-open), so the agent proceeds unchanged.

Options:
  -h, --help          show this help`,
};

function print(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

/**
 * Resolve help text for a command path. Falls back from the most specific
 * path (e.g. "config set") to its parent ("config") to the top-level HELP.
 */
function renderHelp(path: string[]): string {
	const full = path.join(" ");
	if (HELP_INDEX[full]) return HELP_INDEX[full]!;
	if (path.length > 1) {
		const parent = path.slice(0, -1).join(" ");
		if (HELP_INDEX[parent]) return HELP_INDEX[parent]!;
	}
	return HELP;
}

function fail(msg: string, code = 1): void {
	process.stderr.write(`${msg}\n`);
	process.exitCode = code;
}

export async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "-h" || command === "--help") {
		print(HELP);
		return;
	}
	if (command === "version" || command === "--version" || command === "-v") {
		print(VERSION);
		return;
	}

	const env = process.env;

	switch (command) {
		case "analyze": {
			const { flags, positionals } = parseFlags(rest);
			if (wantsHelp(flags, positionals)) {
				print(renderHelp(["analyze"]));
				return;
			}
			const { crops } = parseCropFlags(flags);
			const images = positionals.filter((a) => !a.startsWith("-"));
			if (images.length === 0) {
				fail("analyze requires at least one image path");
				return;
			}
			const formatRaw = str(flags, "format");
			const format =
				formatRaw && formatRaw !== "plain" ? (formatRaw as GroundingFormat) : undefined;
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
				question: str(flags, "question") ?? str(flags, "q"),
				apiKey: str(flags, "api-key") ?? str(flags, "apiKey"),
				env,
			};
			try {
				const outcome = await runAnalyze(images, analyzeFlags);
				if (analyzeFlags.json) {
					print(JSON.stringify({ cacheHit: outcome.cacheHit, records: outcome.records }, null, 2));
				} else {
					print(outcome.output);
				}
			} catch (err) {
				if (err instanceof AnalyzeError) {
					fail(`analyze error: ${err.message}`);
				} else {
					fail(`analyze failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return;
		}

		case "config": {
			const [sub, ...subRest] = rest;
			const { flags, positionals } = parseFlags(subRest);
			if (wantsHelp(flags, [sub ?? ""])) {
				print(renderHelp(["config", sub ?? ""].filter(Boolean) as string[]));
				return;
			}
			switch (sub) {
				case "init":
					handle(await configInit(process.cwd()));
					return;
				case "get":
					handle(await configGet({ configPath: str(flags, "config"), cwd: process.cwd(), env }));
					return;
				case "set": {
					const key = positionals[0];
					const value = positionals[1];
					if (!key || value === undefined) {
						fail("usage: vp config set <key> <value>");
						return;
					}
					handle(await configSet(key, value, process.cwd()));
					return;
				}
				case "validate":
					handle(
						await configValidate({
							configPath: str(flags, "config"),
							cwd: process.cwd(),
							env,
						}),
					);
					return;
				default:
					fail(`unknown config subcommand "${sub ?? ""}". Try: init, get, set, validate`);
			}
			return;
		}

		case "provider": {
			const [sub, ...subRest] = rest;
			const { flags, positionals } = parseFlags(subRest);
			if (wantsHelp(flags, [sub ?? ""])) {
				print(renderHelp(["provider", sub ?? ""].filter(Boolean) as string[]));
				return;
			}
			switch (sub) {
				case "list": {
					const { config } = await loadConfig({ cwd: process.cwd(), env });
					handle(providerList(env, config));
					return;
				}
				case "check": {
					const { config } = await loadConfig({ cwd: process.cwd(), env });
					handle(providerCheck(positionals[0], env, config));
					return;
				}
				case "store-key": {
					const name = positionals[0];
					if (!name) {
						fail("usage: vp provider store-key <name>");
						return;
					}
					handle(await providerStoreKey(name));
					return;
				}
				case "delete-key": {
					const name = positionals[0];
					if (!name) {
						fail("usage: vp provider delete-key <name>");
						return;
					}
					handle(providerDeleteKey(name));
					return;
				}
				case "list-keys":
					handle(providerListKeys());
					return;
				default:
					fail(
						`unknown provider subcommand "${sub ?? ""}". Try: list, check, store-key, delete-key, list-keys`,
					);
			}
			return;
		}

		case "cache": {
			const [sub, ...subRest] = rest;
			const { flags } = parseFlags(subRest);
			if (wantsHelp(flags, [sub ?? ""])) {
				print(renderHelp(["cache", sub ?? ""].filter(Boolean) as string[]));
				return;
			}
			switch (sub) {
				case "status":
					handle(await cacheStatus());
					return;
				case "clear":
					handle(await cacheClearCmd());
					return;
				case "prune":
					handle(
						await cachePruneCmd(str(flags, "older") ? Number(str(flags, "older")) : undefined),
					);
					return;
				default:
					fail(`unknown cache subcommand "${sub ?? ""}". Try: status, clear, prune`);
			}
			return;
		}

		case "integration": {
			const [sub, ...subRest] = rest;
			const { flags, positionals } = parseFlags(subRest);
			if (wantsHelp(flags, [sub ?? ""])) {
				print(renderHelp(["integration", sub ?? ""].filter(Boolean) as string[]));
				return;
			}
			const agent = positionals[0];
			handle(await runIntegration(sub ?? "", agent ?? ""));
			return;
		}

		case "hook": {
			const { flags } = parseFlags(rest);
			if (wantsHelp(flags, rest)) {
				print(renderHelp(["hook"]));
				return;
			}
			runHook(readEvent());
			return;
		}

		default:
			if (isKnownProvider(command)) {
				fail(`"${command}" is a provider, not a command. Did you mean "vp analyze"?`);
			} else {
				fail(`unknown command "${command}". Run "vp help".`);
			}
	}
}

function handle(r: { ok: boolean; message: string; code: number }): void {
	if (r.ok) {
		print(r.message);
	} else {
		fail(r.message, r.code);
	}
}

// Run when invoked directly.
const invokedPath = process.argv[1] ?? "";
const binName = basename(invokedPath);
if (["cli.ts", "cli.js", "vision-proxy", "vp"].includes(binName)) {
	main(process.argv.slice(2)).catch((err) => {
		fail(`fatal: ${err instanceof Error ? err.message : String(err)}`);
	});
}
