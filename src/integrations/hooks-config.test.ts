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
	parseConfig,
	removeHooks,
	stripHookGroups,
} from "./hooks-config.ts";

test("hookGroup carries only standard keys", () => {
	const group = hookGroup("npx tsx /home/u/.claude/hooks/vision-proxy.ts", "Read");
	assert.deepEqual(Object.keys(group).sort(), ["hooks", "matcher"]);
	assert.deepEqual(group.hooks, [
		{
			type: "command",
			command: "npx tsx /home/u/.claude/hooks/vision-proxy.ts",
			timeout: HOOK_TIMEOUT_SEC,
		},
	]);
	assert.equal("vpManaged" in group, false);
	assert.equal("version" in group, false);
	const submit = hookGroup("npx tsx /home/u/.claude/hooks/vision-proxy.ts");
	assert.equal("matcher" in submit, false);
});

test("parseConfig tolerates empty and garbage input", () => {
	assert.deepEqual(parseConfig(""), {});
	assert.deepEqual(parseConfig("   "), {});
	assert.deepEqual(parseConfig("not json{"), {});
	assert.deepEqual(parseConfig('{"hooks":{}}').hooks, {});
});

test("isVisionProxyGroup detects current and legacy registrations", () => {
	const ts = { hooks: [{ type: "command", command: "npx tsx ~/.claude/hooks/vision-proxy.ts" }] };
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
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy.ts";
	const existing = [
		{ hooks: [{ type: "command", command: "node /some/other-hook.mjs", timeout: 10 }] },
		{ hooks: [{ type: "command", command: "node /old/shared.mjs", timeout: 10 }] },
	];
	const merged = mergeHookGroup(existing, hookGroup(cmd));
	assert.equal(merged.length, 2);
	assert.match((merged[1]!.hooks as Array<{ command: string }>)[0]!.command, /vision-proxy\.ts/);
	const again = mergeHookGroup(merged, hookGroup(cmd));
	assert.equal(again.length, 2, "re-install must not duplicate the group");
});

test("stripHookGroups keeps foreign groups and reports removal", () => {
	const foreign = { hooks: [{ type: "command", command: "node /some/other-hook.mjs" }] };
	const ours = { hooks: [{ type: "command", command: "npx tsx ~/vision-proxy.ts" }] };
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
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy.ts";
	for (const raw of [
		JSON.stringify({ hooks: { UserPromptSubmit: { custom: "shape" } } }),
		JSON.stringify({ hooks: [] }),
		"null",
	]) {
		const merged = JSON.parse(applyHooks(raw, cmd));
		assert.equal(merged.hooks.UserPromptSubmit.length, 1);
		assert.match(merged.hooks.UserPromptSubmit[0].hooks[0].command, /vision-proxy\.ts/);
		assert.equal(merged.hooks.PreToolUse.length, 1);
	}
});

test("applyHooks registers both events and preserves foreign groups", () => {
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy.ts";
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

test("applyHooks can register additional tool matchers", () => {
	const cmd = "npx tsx /home/u/.codex/hooks/vision-proxy.ts";
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
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy.ts";
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
	const cmd = "npx tsx /home/u/.claude/hooks/vision-proxy.ts";
	assert.equal(hooksInstalled(applyHooks("{}", cmd)), true);
	assert.equal(hooksInstalled("{}"), false);
	assert.equal(hooksInstalled("garbage"), false);
});
