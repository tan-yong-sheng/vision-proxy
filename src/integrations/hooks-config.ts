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
		return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Detect a vision-proxy hook registration, current or stale: the generated
 * `.ts` script, the previous `vp hook` binary installs (tagged or not), and
 * the old `.mjs` shims that shipped before the binary-as-hook rewrite.
 */
export function isVisionProxyGroup(group: Record<string, unknown>): boolean {
	// Registrations tagged by the previous installer generation.
	if (group.vpManaged === true) return true;
	const hooks = (group.hooks as Array<{ command?: string }> | undefined) ?? [];
	return hooks.some((h) => {
		if (typeof h.command !== "string") return false;
		const cmd = h.command;
		// The generated hook script installed by the current installer.
		if (/vision-proxy\.ts\b/.test(cmd)) return true;
		// Old `.mjs` shims that shipped before the binary-as-hook rewrite.
		if (/\b(claude-code-user-prompt-submit|codex-user-prompt-submit|shared)\.mjs\b/.test(cmd))
			return true;
		// Previous binary-as-hook installs that invoked `vp hook` directly.
		if (/\b(vp|vision-proxy|cli\.js)\s+hook$/.test(cmd)) return true;
		// Any command explicitly mentioning the vision-proxy package/repository path.
		if (/\bvision-proxy\b/.test(cmd)) return true;
		return false;
	});
}

/** Merge `group` into a hook-event array, replacing any existing vision-proxy registration. */
export function mergeHookGroup(
	existing: unknown,
	group: Record<string, unknown>,
): Record<string, unknown>[] {
	const list = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
	const without = list.filter((g) => !isVisionProxyGroup(g));
	without.push(group);
	return without;
}

/** Drop every vision-proxy group from a hook-event array. */
export function stripHookGroups(existing: unknown): {
	groups: Record<string, unknown>[];
	removed: boolean;
} {
	const list = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
	const kept = list.filter((g) => !isVisionProxyGroup(g));
	return { groups: kept, removed: kept.length !== list.length };
}

/**
 * Register both hook types (UserPromptSubmit + PreToolUse Read) into a hooks
 * config object serialized as JSON. Shared by Claude Code (settings.json) and
 * Codex (hooks.json), which use the same shape.
 */
export function applyHooks(raw: string, command: string): string {
	const cfg = parseConfig(raw);
	if (!cfg.hooks) cfg.hooks = {};
	const hooks = (cfg.hooks as Record<string, unknown>) || {};
	hooks.UserPromptSubmit = mergeHookGroup(hooks.UserPromptSubmit, hookGroup(command));
	hooks.PreToolUse = mergeHookGroup(hooks.PreToolUse, hookGroup(command, "Read"));
	cfg.hooks = hooks;
	return JSON.stringify(cfg, null, 2);
}

/** Remove both vision-proxy hook registrations from a hooks config JSON string. */
export function removeHooks(raw: string): { raw: string; removed: boolean } {
	const cfg = parseConfig(raw);
	const hooks = (cfg.hooks as Record<string, unknown>) || {};
	if (!Array.isArray(hooks.UserPromptSubmit) && !Array.isArray(hooks.PreToolUse)) {
		return { raw, removed: false };
	}
	const ups = stripHookGroups(hooks.UserPromptSubmit);
	const pts = stripHookGroups(hooks.PreToolUse);
	const removed = ups.removed || pts.removed;
	if (ups.groups.length === 0) delete hooks.UserPromptSubmit;
	else hooks.UserPromptSubmit = ups.groups;
	if (pts.groups.length === 0) delete hooks.PreToolUse;
	else hooks.PreToolUse = pts.groups;
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
