#!/usr/bin/env node
/**
 * vision-proxy / vp CLI entry point.
 *
 * Command tree:
 *   analyze <paths...> [--format] [--provider] [--model] [--joint] [--crop i:form]
 *                     [--no-fence] [--config] [--json] [--max-output-tokens] [--question] [--api-key]
 *   config   init | get | set <k> <v> | validate
 *   provider list | check [<name>] | store-key <name> | delete-key <name> | list-keys
 *   cache    status | clear | prune [--older <days>]
 *   integration install | show | list | uninstall <agent>
 *   version | help
 */
import { runAnalyze, parseCropFlags, AnalyzeError, type AnalyzeFlags } from "./commands/analyze.ts";
import {
	configInit,
	configGet,
	configSet,
	configValidate,
} from "./commands/config.ts";
import {
	providerList,
	providerCheck,
	providerStoreKey,
	providerDeleteKey,
	providerListKeys,
} from "./commands/provider.ts";
import { cacheStatus, cacheClearCmd, cachePruneCmd } from "./commands/cache.ts";
import { runIntegration } from "./commands/integration.ts";
import { isKnownProvider } from "./provider.ts";
import type { GroundingFormat } from "./core.ts";
import { basename } from "node:path";

const VERSION = "0.1.0";

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

function parseFlags(args: string[]): FlagParse {
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
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					collectFlag(flags, a.slice(2), next);
					i++;
				} else {
					collectFlag(flags, a.slice(2), true);
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
				if (next !== undefined && !next.startsWith("-")) {
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
  uninstall <agent>          remove the integration
`;

function print(msg: string): void {
	process.stdout.write(msg + "\n");
}

function fail(msg: string, code = 1): void {
	process.stderr.write(msg + "\n");
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
			const { crops } = parseCropFlags(flags);
			const images = positionals.filter((a) => !a.startsWith("-"));
			if (images.length === 0) {
				fail("analyze requires at least one image path");
				return;
			}
			const formatRaw = str(flags, "format");
			const format = formatRaw && formatRaw !== "plain" ? (formatRaw as GroundingFormat) : undefined;
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
					print(
						JSON.stringify(
							{ cacheHit: outcome.cacheHit, records: outcome.records },
							null,
							2,
						),
					);
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
			const { positionals } = parseFlags(subRest);
			switch (sub) {
				case "list":
					handle(providerList(env));
					return;
				case "check":
					handle(providerCheck(positionals[0], env));
					return;
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
					fail(`unknown provider subcommand "${sub ?? ""}". Try: list, check, store-key, delete-key, list-keys`);
			}
			return;
		}

		case "cache": {
			const [sub, ...subRest] = rest;
			const { flags } = parseFlags(subRest);
			switch (sub) {
				case "status":
					handle(await cacheStatus());
					return;
				case "clear":
					handle(await cacheClearCmd());
					return;
				case "prune":
					handle(await cachePruneCmd(str(flags, "older") ? Number(str(flags, "older")) : undefined));
					return;
				default:
					fail(`unknown cache subcommand "${sub ?? ""}". Try: status, clear, prune`);
			}
			return;
		}

		case "integration": {
			const [sub, ...subRest] = rest;
			const { positionals } = parseFlags(subRest);
			const agent = positionals[0];
			handle(await runIntegration(sub ?? "", agent ?? ""));
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
