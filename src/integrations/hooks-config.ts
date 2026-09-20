/**
 * Config adapter for hook agents (Claude Code, Codex).
 *
 * Pure JSON helpers for the shared hooks-config shape (`{ hooks: {
 * UserPromptSubmit, PreToolUse } }`). No filesystem access and no host paths:
 * callers supply the raw config text and the hook command, and receive the
 * serialized config back. Host configs stay free of vision-proxy metadata;
 * the version marker lives in the generated script file instead.
 */

/** Timeout (seconds) written into every generated hook group. */
export const HOOK_TIMEOUT_SEC = 30;

/**
 * Build an agent hook group (one plain command invocation of the hook script).
 *
 * The group carries only standard keys (`hooks`, plus `matcher` for
 * `PreToolUse`) so the host config stays free of vision-proxy metadata.
 */
export function hookGroup(command: string, matcher?: string): Record<string, unknown> {
	const group: Record<string, unknown> = {
		hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SEC }],
	};
	if (matcher) group.matcher = matcher;
	return group;
}

/** Parse a hooks config JSON string into an object (empty object on garbage). */
export function parseConfig(raw: string): Record<string, unknown> {
	try {
		const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Detect a vision-proxy hook registration, current or stale: the generated
 * `.ts` script run via `npx tsx`, the previous `vp hook` binary installs
 * (tagged or not), and the old `.mjs` shims that shipped before the
 * binary-as-hook rewrite.
 *
 * A bare `\bvision-proxy\b` mention is deliberately NOT a match: user hooks
 * that merely reference the repository path (e.g. `cd ~/vision-proxy && make`)
 * must never be treated as ours and deleted on reinstall/uninstall.
 */
export function isVisionProxyGroup(group: Record<string, unknown>): boolean {
	// Registrations tagged by the previous installer generation.
	if (group.vpManaged === true) return true;
	const hooks = (group.hooks as Array<{ command?: string }> | undefined) ?? [];
	return hooks.some((h) => {
		if (typeof h.command !== "string") return false;
		const cmd = h.command;
		// The generated hook script installed by the current installer
		// (feature-suffix naming) and the legacy-named file it superseded,
		// so stale registrations are still recognized on reinstall/uninstall.
		if (/vision-proxy(_read)?\.ts\b/.test(cmd)) return true;
		// Old `.mjs` shims that shipped before the binary-as-hook rewrite,
		// including the `-vision-proxy-` infix variants from earlier generations.
		// (Only filenames observed in history are listed; a bare
		// `vision-proxy.mjs` never shipped, so it is deliberately absent.)
		if (
			/\b(claude-code-(vision-proxy-)?user-prompt-submit|codex-(vision-proxy-)?user-prompt-submit|shared)\.mjs\b/.test(
				cmd,
			)
		)
			return true;
		// Previous binary-as-hook installs that invoked `vp hook` directly. The
		// cli.js form is restricted to a vision-proxy/vp path so an unrelated
		// `node ./scripts/cli.js hook` registration is never removed.
		if (/\b(vp|vision-proxy)\s+hook(\s|$)/.test(cmd)) return true;
		if (/(?:vision-proxy|vp)[/\\][^\s]*cli\.js\s+hook(\s|$)/i.test(cmd)) return true;
		return false;
	});
}

/**
 * Merge `group` into a hook-event array, replacing any existing vision-proxy registration.
 *
 * A non-array existing value is REPLACED, not merged: install must yield a
 * valid array registration (the host schema requires arrays), and an unknown
 * shape cannot carry our group. This is the deliberate counterpart to the
 * uninstall path (`stripHookGroups`/`removeHooks`), which preserves non-array
 * values untouched — install must register to fulfill its contract, uninstall
 * must never destroy what it does not own.
 */
export function mergeHookGroup(
	existing: unknown,
	group: Record<string, unknown>,
): Record<string, unknown>[] {
	const list = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
	const without = list.filter((g) => !isVisionProxyGroup(g));
	without.push(group);
	return without;
}

/**
 * Drop every vision-proxy group from a hook-event value.
 *
 * Non-array user-authored values are returned untouched (removed: false) so
 * uninstall never deletes a custom shape it does not own; callers only
 * rewrite the event when the original value was an array.
 */
export function stripHookGroups(existing: unknown): {
	groups: unknown;
	removed: boolean;
} {
	if (!Array.isArray(existing)) return { groups: existing, removed: false };
	const list = existing as Record<string, unknown>[];
	const kept = list.filter((g) => !isVisionProxyGroup(g));
	return { groups: kept, removed: kept.length !== list.length };
}

/**
 * Register UserPromptSubmit plus the requested PreToolUse matchers into a
 * hooks config object serialized as JSON. Shared by Claude Code (settings.json)
 * and Codex (hooks.json), which use the same shape.
 *
 * Non-array event values are replaced with a fresh registration (see
 * `mergeHookGroup`): install cannot merge into an unknown shape and must
 * leave a working registration behind. The uninstall path preserves such
 * values instead of discarding them.
 */
export function applyHooks(
	raw: string,
	command: string,
	preToolUseMatchers: string[] = ["Read"],
): string {
	const cfg = parseConfig(raw);
	const existing = cfg.hooks;
	const hooks =
		existing !== null && typeof existing === "object" && !Array.isArray(existing)
			? (existing as Record<string, unknown>)
			: {};
	hooks.UserPromptSubmit = mergeHookGroup(hooks.UserPromptSubmit, hookGroup(command));
	let preToolUse = hooks.PreToolUse;
	if (preToolUseMatchers.length > 0) {
		preToolUse = mergeHookGroup(preToolUse, hookGroup(command, preToolUseMatchers[0]));
		for (const matcher of preToolUseMatchers.slice(1)) {
			(preToolUse as Record<string, unknown>[]).push(hookGroup(command, matcher));
		}
	}
	hooks.PreToolUse = preToolUse;
	cfg.hooks = hooks;
	return JSON.stringify(cfg, null, 2);
}

/**
 * Remove both vision-proxy hook registrations from a hooks config JSON string.
 *
 * Non-array user-authored event values are preserved untouched: only array
 * events have vision-proxy groups stripped out of them.
 */
export function removeHooks(raw: string): { raw: string; removed: boolean } {
	const cfg = parseConfig(raw);
	const hooks = (cfg.hooks as Record<string, unknown>) || {};
	if (!Array.isArray(hooks.UserPromptSubmit) && !Array.isArray(hooks.PreToolUse)) {
		return { raw, removed: false };
	}
	let removed = false;
	for (const event of ["UserPromptSubmit", "PreToolUse"] as const) {
		const value = hooks[event];
		if (!Array.isArray(value)) continue;
		const { groups, removed: eventRemoved } = stripHookGroups(value);
		const kept = groups as Record<string, unknown>[];
		removed = removed || eventRemoved;
		if (kept.length === 0) delete hooks[event];
		else hooks[event] = kept;
	}
	if (Object.keys(hooks).length === 0) delete cfg.hooks;
	return { raw: JSON.stringify(cfg, null, 2), removed };
}

/** Whether a hooks config JSON contains any vision-proxy registration. */
export function hooksInstalled(raw: string): boolean {
	const cfg = parseConfig(raw);
	const hooks = (cfg.hooks as Record<string, unknown>) || {};
	const has = (arr: unknown) =>
		Array.isArray(arr) && (arr as Record<string, unknown>[]).some((g) => isVisionProxyGroup(g));
	return has(hooks.UserPromptSubmit) || has(hooks.PreToolUse);
}
