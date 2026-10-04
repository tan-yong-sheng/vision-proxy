/**
 * Unit tests for the hooks-config adapter (shared Claude Code / Codex shape).
 *
 * Pins the metadata-free contract: generated groups carry only standard keys,
 * install merges both hook events idempotently, uninstall strips only
 * vision-proxy groups, and detection covers the current `.ts` script plus the
 * legacy `.mjs` shims, `vp hook` binaries, and `vpManaged` tags.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyHooks,
	HOOK_TIMEOUT_SEC,
	hookGroup,
	hooksInstalled,
	isVisionProxyGroup,
	mergeHookGroup,
	mergeHookGroups,
	parseConfig,
	removeHooks,
	stripHookGroups,
} from "./hooks-config.ts";

test("hookGroup carries only standard keys", () => {
	const group = hookGroup("npx tsx /home/u/.claude/hooks/vision-proxy_read.ts", "Read");
	assert.deepEqual(Object.keys(group).sort(), ["hooks", "matcher"]);
	assert.deepEqual(group.hooks, [
		{
			type: "command",
			command: "npx tsx /home/u/.claude/hooks/vision-proxy_read.ts",
			timeout: HOOK_TIMEOUT_SEC,
		},
	]);
	assert.equal("vpManaged" in group, false);
	assert.equal("version" in group, false);
	const submit = hookGroup("npx tsx /home/u/.claude/hooks/vision-proxy_read.ts");
	assert.equal("matcher" in submit, false);
});

test("parseConfig tolerates empty and garbage input", () => {
	assert.deepEqual(parseConfig(""), {});
	assert.deepEqual(parseConfig("   "), {});
	assert.deepEqual(parseConfig("not json{"), {});
	assert.deepEqual(parseConfig('{"hooks":{}}').hooks, {});
});

test("isVisionProxyGroup detects current and legacy registrations", () => {
	const ts = {
		hooks: [{ type: "command", command: "npx tsx ~/.claude/hooks/vision-proxy_read.ts" }],
	};
	assert.equal(isVisionProxyGroup(ts), true);
	assert.equal(
		isVisionProxyGroup({ hooks: [{ type: "command", command: "node /old/shared.mjs" }] }),
		true,
	);
	assert.equal(
		isVisionProxyGroup({ hooks: [{ type: "command", command: "/usr/local/bin/vp hook" }] }),
		true,
	);
	assert.equal(isVisionProxyGroup({ vpManaged: true, hooks: [] }), true);
	assert.equal(
		isVisionProxyGroup({ hooks: [{ type: "command", command: "node /some/other-hook.mjs" }] }),
		false,
	);
	assert.equal(isVisionProxyGroup({ hooks: [] }), false);
});

test("isVisionProxyGroup ignores user hooks that merely mention vision-proxy", () => {
	// A bare path mention must never be treated as ours and deleted.
	assert.equal(
		isVisionProxyGroup({ hooks: [{ type: "command", command: "cd ~/vision-proxy && make" }] }),
		false,
	);
	assert.equal(
		isVisionProxyGroup({
			hooks: [{ type: "command", command: "node /home/u/repos/vision-proxy/scripts/x.mjs" }],
		}),
		false,
	);
});

test("isVisionProxyGroup still detects known legacy variants", () => {
	for (const cmd of [
		"node /old/claude-code-user-prompt-submit.mjs",
		"node /old/codex-user-prompt-submit.mjs",
		"node /old/claude-code-vision-proxy-user-prompt-submit.mjs",
		"node /old/codex-vision-proxy-user-prompt-submit.mjs",
		"/usr/local/bin/vp hook --verbose",
		"node /opt/vp/dist/cli.js hook",
	]) {
		assert.equal(
			isVisionProxyGroup({ hooks: [{ type: "command", command: cmd }] }),
			true,
			`${cmd} must be detected`,
		);
	}
	assert.equal(
		isVisionProxyGroup({
			hooks: [{ type: "command", command: "node ./scripts/cli.js hook --check" }],
		}),
		false,
	);
});

test("mergeHookGroup replaces existing vp registration without duplicating", () => {
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy_read.ts";
	const existing = [
		{ hooks: [{ type: "command", command: "node /some/other-hook.mjs", timeout: 10 }] },
		{ hooks: [{ type: "command", command: "node /old/shared.mjs", timeout: 10 }] },
	];
	const merged = mergeHookGroup(existing, hookGroup(cmd));
	assert.equal(merged.length, 2);
	assert.match(
		(merged[1]!.hooks as Array<{ command: string }>)[0]!.command,
		/vision-proxy(_read)?\.ts/,
	);
	const again = mergeHookGroup(merged, hookGroup(cmd));
	assert.equal(again.length, 2, "re-install must not duplicate the group");
});

test("mergeHookGroups overwrites vp groups in place to preserve host trust indices", () => {
	const cmd = "node --experimental-strip-types /home/u/.codex/hooks/vision-proxy_read.ts";
	const foreign = (name: string) => ({
		hooks: [{ type: "command", command: name, timeout: 10 }],
	});
	const vp = (matcher: string) => hookGroup(cmd, matcher);
	// Codex shape: [foreign-Bash, foreign-all, vp-view_image, vp-Bash].
	const existing = [foreign("dcg"), foreign("orca"), vp("view_image"), vp("Bash")];
	const merged = mergeHookGroups(existing, [vp("view_image"), vp("Bash")]);
	assert.equal(merged.length, 4, "same matcher count must not move groups");
	assert.deepEqual(merged[0], foreign("dcg"), "foreign groups must be untouched");
	assert.deepEqual(merged[1], foreign("orca"), "foreign groups must be untouched");
	assert.deepEqual((merged[2] as { matcher: string }).matcher, "view_image");
	assert.deepEqual((merged[3] as { matcher: string }).matcher, "Bash");
	// Shrinking (Read-removal era: 3 matchers -> 2) drops the surplus
	// last-to-first so surviving indices never shift.
	const legacy = [foreign("dcg"), vp("Read"), vp("view_image"), vp("Bash")];
	const shrunk = mergeHookGroups(legacy, [vp("view_image"), vp("Bash")]);
	assert.equal(shrunk.length, 3);
	assert.deepEqual(shrunk[0], foreign("dcg"));
	assert.deepEqual((shrunk[1] as { matcher: string }).matcher, "view_image");
	assert.deepEqual((shrunk[2] as { matcher: string }).matcher, "Bash");
	// Growing appends after all existing entries, so no foreign group's index
	// moves -- including one trailing after the vp slots.
	const interleaved = [foreign("dcg"), vp("view_image"), foreign("tail")];
	const grown = mergeHookGroups(interleaved, [vp("view_image"), vp("Bash")]);
	assert.equal(grown.length, 4);
	assert.deepEqual(grown[0], foreign("dcg"), "leading foreign group must not move");
	assert.deepEqual(grown[2], foreign("tail"), "trailing foreign group must not move");
	assert.deepEqual((grown[3] as { matcher: string }).matcher, "Bash");
	// Re-apply is idempotent.
	const twice = mergeHookGroups(merged, [vp("view_image"), vp("Bash")]);
	assert.deepEqual(twice, merged);
});

test("stripHookGroups keeps foreign groups and reports removal", () => {
	const foreign = { hooks: [{ type: "command", command: "node /some/other-hook.mjs" }] };
	const ours = { hooks: [{ type: "command", command: "npx tsx ~/vision-proxy_read.ts" }] };
	const { groups, removed } = stripHookGroups([foreign, ours]);
	assert.equal(removed, true);
	assert.deepEqual(groups, [foreign]);
	assert.deepEqual(stripHookGroups([foreign]), { groups: [foreign], removed: false });
});

test("stripHookGroups preserves non-array user-authored values untouched", () => {
	const custom = { custom: "shape" };
	assert.deepEqual(stripHookGroups(custom), { groups: custom, removed: false });
	assert.deepEqual(stripHookGroups("string-value"), {
		groups: "string-value",
		removed: false,
	});
	assert.deepEqual(stripHookGroups(undefined), { groups: undefined, removed: false });
});

test("applyHooks replaces non-object containers with working registrations", () => {
	// Install must register (the host schema requires arrays), while uninstall
	// preserves such values untouched: deliberate asymmetry, pinned here.
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy_read.ts";
	for (const raw of [
		JSON.stringify({ hooks: { UserPromptSubmit: { custom: "shape" } } }),
		JSON.stringify({ hooks: [] }),
		"null",
	]) {
		const merged = JSON.parse(applyHooks(raw, cmd));
		assert.equal(merged.hooks.UserPromptSubmit.length, 1);
		assert.match(merged.hooks.UserPromptSubmit[0].hooks[0].command, /vision-proxy(_read)?\.ts/);
		// Legacy-named registrations are still recognized as ours.
		assert.equal(
			isVisionProxyGroup({ hooks: [{ type: "command", command: "npx tsx ~/vision-proxy.ts" }] }),
			true,
		);
		assert.equal(merged.hooks.PreToolUse.length, 1);
	}
});

test("applyHooks registers both events and preserves foreign groups", () => {
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy_read.ts";
	const raw = JSON.stringify({
		hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other", timeout: 5 }] }] },
	});
	const merged = JSON.parse(applyHooks(raw, cmd));
	assert.equal(merged.hooks.UserPromptSubmit.length, 2);
	assert.equal(merged.hooks.PreToolUse.length, 1);
	assert.equal(merged.hooks.PreToolUse[0].matcher, "Read");
	// Re-apply is idempotent: one vp group per event.
	const twice = JSON.parse(applyHooks(JSON.stringify(merged), cmd));
	assert.equal(twice.hooks.UserPromptSubmit.length, 2);
	assert.equal(twice.hooks.PreToolUse.length, 1);
});

test("applyHooks reinstall keeps vp groups at their indices", () => {
	const cmd = "node --experimental-strip-types /home/u/.codex/hooks/vision-proxy_read.ts";
	const foreign = { hooks: [{ type: "command", command: "dcg", timeout: 10 }] };
	const raw = JSON.stringify({
		hooks: {
			PreToolUse: [foreign, hookGroup(cmd, "view_image"), hookGroup(cmd, "Bash")],
		},
	});
	const merged = JSON.parse(applyHooks(raw, cmd, ["view_image", "Bash"]));
	assert.equal(merged.hooks.PreToolUse.length, 3);
	assert.deepEqual(merged.hooks.PreToolUse[0], foreign);
	assert.equal(merged.hooks.PreToolUse[1].matcher, "view_image");
	assert.equal(merged.hooks.PreToolUse[2].matcher, "Bash");
	// A second apply must produce byte-identical output (trust hash stable).
	assert.equal(
		applyHooks(JSON.stringify(merged), cmd, ["view_image", "Bash"]),
		JSON.stringify(merged, null, 2),
	);
});

test("applyHooks can register additional tool matchers", () => {
	const cmd = "npx tsx /home/u/.codex/hooks/vision-proxy_read.ts";
	const merged = JSON.parse(applyHooks("{}", cmd, ["Read", "view_image"]));
	assert.deepEqual(
		merged.hooks.PreToolUse.map((group: { matcher: string }) => group.matcher),
		["Read", "view_image"],
	);
	const twice = JSON.parse(applyHooks(JSON.stringify(merged), cmd, ["Read", "view_image"]));
	assert.deepEqual(
		twice.hooks.PreToolUse.map((group: { matcher: string }) => group.matcher),
		["Read", "view_image"],
	);
});

test("removeHooks drops only vision-proxy groups", () => {
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy_read.ts";
	const raw = JSON.stringify({
		hooks: {
			UserPromptSubmit: [
				{ hooks: [{ type: "command", command: "node /some/other-hook.mjs", timeout: 10 }] },
				hookGroup(cmd),
			],
			PreToolUse: [hookGroup(cmd, "Read")],
		},
	});
	const { raw: cleaned, removed } = removeHooks(raw);
	assert.equal(removed, true);
	const cfg = JSON.parse(cleaned);
	assert.equal(cfg.hooks.UserPromptSubmit.length, 1);
	assert.match(cfg.hooks.UserPromptSubmit[0].hooks[0].command, /other-hook/);
	assert.equal(cfg.hooks.PreToolUse, undefined);
	assert.deepEqual(removeHooks(JSON.stringify({})), { raw: JSON.stringify({}), removed: false });
});

test("removeHooks preserves non-array user-authored event values", () => {
	const raw = JSON.stringify({
		hooks: {
			UserPromptSubmit: { custom: "shape" },
			PreToolUse: [{ hooks: [{ type: "command", command: "node /some/other-hook.mjs" }] }],
		},
	});
	const { raw: cleaned, removed } = removeHooks(raw);
	assert.equal(removed, false);
	const cfg = JSON.parse(cleaned);
	assert.deepEqual(cfg.hooks.UserPromptSubmit, { custom: "shape" });
	assert.equal(cfg.hooks.PreToolUse.length, 1);
});

test("hooksInstalled detects either event", () => {
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy_read.ts";
	assert.equal(hooksInstalled(applyHooks("{}", cmd)), true);
	assert.equal(hooksInstalled("{}"), false);
	assert.equal(hooksInstalled("garbage"), false);
});
