/**
 * Integrations module public surface.
 *
 * `src/commands/integration.ts` re-exports this module so existing CLI and
 * test imports keep working while host knowledge lives here: `catalog.ts`
 * owns per-host paths, generated sources, and legacy cleanups; `lifecycle.ts`
 * owns install/show/list/status/uninstall orchestration; `hooks-config.ts`
 * owns the shared hooks-JSON shape for Claude Code and Codex.
 */
export {
	claudeCodeConfigPath,
	claudeHookScriptPath,
	codexConfigPath,
	codexHookScriptPath,
	generateHookScript,
	generateOpencodePlugin,
	generatePiExtension,
	getHomeDir,
	legacyMarkerPath,
	makeTsHookCommand,
	opencodePluginsDir,
	piExtensionsDir,
	quotePath,
	removeLegacyCodexConfigToml,
	SUPPORTED,
	specFor,
} from "./catalog.ts";
export {
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
export {
	integrationInstall,
	integrationList,
	integrationShow,
	integrationStatus,
	integrationUninstall,
	runIntegration,
} from "./lifecycle.ts";
export type {
	AgentSpec,
	AgentTargetOpts,
	IntegrationInstallOptions,
	IntegrationResult,
} from "./types.ts";
