#!/usr/bin/env node
/**
 * vision-proxy / vp CLI entry point (process adapter).
 *
 * Command tree:
 *   analyze <paths...> [--format] [--provider] [--model] [--joint] [--crop i:form]
 *                     [--no-fence] [--config] [--json] [--max-output-tokens] [--question] [--context] [--api-key]
 *   config   init | get | set <k> <v> | validate
 *   provider list | check [<name>] | store-key <name> | delete-key <name> | list-keys
 *   cache    status | clear | prune [--older <days>]
 *   integration install | show | list | status | uninstall <agent>
 *   update [--check] [--version <tag>] [--force] [--beta]
 *   version | help
 *
 * Every command except any `--json` invocation runs the cached
 * update-notifier check first; see commands/update.ts for the suppression rules.
 *
 * Command grammar, help text, dispatch, and result mapping live in
 * `./command-runner.ts`. This module only adapts that runner to the process:
 * argv in, stdout/stderr/exit-code out, plus the update-notifier setup.
 */
import { basename } from "node:path";
import { type FlagParse, parseFlags, runCommand } from "./command-runner.ts";
import { checkAutoUpdateNotification } from "./commands/update.ts";

export type { FlagParse };
export { parseFlags };

function print(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

function fail(msg: string, code = 1): void {
	process.stderr.write(`${msg}\n`);
	process.exitCode = code;
}

/**
 * CLI entry point used by the binary and existing tests.
 *
 * Runs the cached update-notifier check (suppressed for `--json` and the
 * notifier's own worker so machine consumers stay byte-for-byte clean), then
 * delegates to the command runner and maps its outcome onto stdout/stderr
 * plus `process.exitCode`.
 */
export async function main(argv: string[]): Promise<void> {
	const env = process.env;

	// Cached, non-blocking check, before any command runs. Suppressed for
	// `--json` and the notifier's own worker so machine consumers stay
	// byte-for-byte clean. argv already excludes the binary name, so the
	// whole argv is scanned: a leading `--json` / `--background-check`
	// must suppress the banner too.
	const machineReadable = argv.some(
		(a) => a === "--json" || a.startsWith("--json=") || a === "--background-check",
	);
	checkAutoUpdateNotification({ env, json: machineReadable });

	const result = await runCommand(argv, { env, cwd: process.cwd() });
	if (result.stdout !== undefined) print(result.stdout);
	if (result.stderr !== undefined) fail(result.stderr, result.code);
	else if (result.code !== 0) process.exitCode = result.code;
}

// Run when invoked directly.
const invokedPath = process.argv[1] ?? "";
const binName = basename(invokedPath);
if (["cli.ts", "cli.js", "vision-proxy", "vp"].includes(binName)) {
	main(process.argv.slice(2)).catch((err) => {
		fail(`fatal: ${err instanceof Error ? err.message : String(err)}`);
	});
}
