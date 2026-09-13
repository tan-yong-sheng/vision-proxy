/**
 * Shared types for the integrations catalog and lifecycle.
 *
 * The `AgentSpec` interface is the installer-side seam: hook agents
 * (Claude Code, Codex) translate a generated script plus a JSON hooks config,
 * while file agents (Pi, opencode) treat the generated file as the install
 * signal. Host quirks stay in the catalog; lifecycle policy stays in
 * `lifecycle.ts`; command wiring stays in `src/commands/integration.ts`.
 */

/** Result shape returned by every integration lifecycle function. */
export interface IntegrationResult {
	ok: boolean;
	message: string;
	code: number;
}

/** Options accepted by install/uninstall. */
export interface IntegrationInstallOptions {
	/** Override the directory where generated files are written (defaults per-agent). */
	installDir?: string;
	/** Generate a local-development artifact that defaults to the current CLI entry point. */
	dev?: boolean;
}

/** Options passed to per-agent path resolution. */
export interface AgentTargetOpts {
	installDir?: string;
}

/**
 * Per-host install adapter.
 *
 * @tags integration, catalog
 */
export interface AgentSpec {
	/** Human-readable name used in messages. */
	id: string;
	/** Where the installed artifact lives (abs path). */
	target(opts: AgentTargetOpts): string;
	/** Human-readable install location used in messages. */
	locationLabel(opts: AgentTargetOpts): string;
	/** Produce the generated file content (version marker + script source). */
	generate(defaultVpBin?: string): string;
	/** Read + return the host config file text (empty string if absent). */
	readConfig(): { raw: string };
	/** Config file edited by install/uninstall (the host's settings/hooks json). */
	configPath(): string;
	/** The hook command written into the agent config (plain `npx tsx`). */
	hookCommand(): string;
	/** Apply the hook registrations to the config; returns new serialized config. */
	apply(raw: string): string;
	/** Remove our registrations from the config; returns new serialized config + whether anything was removed. */
	remove(raw: string): { raw: string; removed: boolean };
	/** Whether the config currently contains our hook registrations. */
	isInstalled(raw?: string): boolean;
	/** Version stamped into the installed artifact, or undefined if absent/unstamped. */
	installedVersion(opts: AgentTargetOpts): string | undefined;
}
