/**
 * Shared spawn resolution for entry-point paths.
 *
 * Single home for the `.js`-through-node routing used by both the update
 * notifier (`src/commands/update.ts`) and the standalone hook runtime
 * (`src/hooks/runtime.ts`). When the entry is a `.js` file (e.g. the compiled
 * `dist/cli.js` shipped without the exec bit), spawning it directly fails
 * with EACCES — re-run it under `process.execPath` instead. For any other
 * path (the `vp` launcher wrapper or symlink) return it as-is.
 *
 * Declared without an inline `export` keyword so `Function.prototype.toString`
 * yields a clean function statement for the standalone sources that inline
 * this via `HOOK_RUNTIME_SOURCE`.
 */
function vpEntryToSpawn(cmd: string): { command: string; args: string[] } {
	if (/\.js$/i.test(cmd)) {
		return { command: process.execPath, args: [cmd] };
	}
	return { command: cmd, args: [] };
}

export { vpEntryToSpawn };
