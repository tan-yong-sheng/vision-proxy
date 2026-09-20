/**
 * Shared spawn resolution for entry-point paths.
 *
 * Single home for the `.js`-through-node routing used by both the update
 * notifier (`src/commands/update.ts`) and the standalone hook runtime
 * (`src/integrations/runtime.ts`). When the entry is a `.js` file (e.g. the compiled
 * `dist/cli.js` shipped without the exec bit), spawning it directly fails
 * with EACCES — re-run it under the current Node executable, or under the
 * `node` launcher when the host runtime is Bun (as in OpenCode). For any
 * other path (the `vp` launcher wrapper or symlink) return it as-is.
 *
 * Declared without an inline `export` keyword so `Function.prototype.toString`
 * yields a clean function statement for the standalone sources that inline
 * this via `HOOK_RUNTIME_SOURCE`.
 */
function vpEntryToSpawn(cmd: string): { command: string; args: string[] } {
	if (/\.js$/i.test(cmd)) {
		// OpenCode loads plugins in Bun. In that host process.execPath is the
		// opencode executable, not a JavaScript runtime; passing cli.js to it
		// makes opencode parse the CLI arguments and print its own help. Use the
		// Node launcher for compiled vision-proxy entry points under Bun.
		const runner = process.versions.bun ? "node" : process.execPath;
		return { command: runner, args: [cmd] };
	}
	return { command: cmd, args: [] };
}

export { vpEntryToSpawn };
