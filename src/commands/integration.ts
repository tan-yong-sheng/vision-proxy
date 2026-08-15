/**
 * `vp integration` — install/uninstall the vision-proxy integration for an agent.
 *
 * Subcommands:
 *   install <agent>   writes the integration into the agent's extensions directory.
 *   show <agent>      print the generated extension source for manual review.
 *   uninstall <agent> removes the generated extension file.
 *
 * Agents supported first: `pi` (Pi coding agent global extensions directory).
 * The Pi extension source is embedded in `src/pi-extension.ts` and written verbatim.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PI_EXTENSION_SOURCE } from "../pi-extension.ts";

const SUPPORTED = ["pi"];
const EXTENSION_FILENAME = "vision-proxy.ts";

export interface IntegrationResult {
	ok: boolean;
	message: string;
	code: number;
}

interface AgentSpec {
	/** Absolute path of the generated extension file. */
	target(opts: { installDir?: string }): string;
	/** Human-readable location used in messages. */
	locationLabel(opts: { installDir?: string }): string;
}

function piExtensionsDir(): string {
	return join(homedir(), ".pi", "agent", "extensions");
}

const piSpec: AgentSpec = {
	target: ({ installDir }) => join(installDir ?? piExtensionsDir(), EXTENSION_FILENAME),
	locationLabel: ({ installDir }) => join(installDir ?? piExtensionsDir(), EXTENSION_FILENAME),
};

function specFor(agent: string): AgentSpec | undefined {
	if (agent === "pi") return piSpec;
	return undefined;
}

function rejectUnknownAgent(agent: string): IntegrationResult {
	return {
		ok: false,
		message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
		code: 1,
	};
}

interface IntegrationInstallOptions {
	/** Override the directory where the extension is written (defaults to Pi's global extensions dir). */
	installDir?: string;
}

// fallow-ignore-next-line unused-export
export async function integrationInstall(
	agent: string,
	opts: IntegrationInstallOptions = {},
): Promise<IntegrationResult> {
	const spec = specFor(agent);
	if (!spec) return rejectUnknownAgent(agent);
	const target = spec.target({ installDir: opts.installDir });
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, PI_EXTENSION_SOURCE, { mode: 0o644 });
	return {
		ok: true,
		message: `installed ${agent} integration -> ${target}`,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
export async function integrationShow(agent: string): Promise<IntegrationResult> {
	const spec = specFor(agent);
	if (!spec) {
		return {
			ok: false,
			message: `unknown agent "${agent}". Supported: ${SUPPORTED.join(", ")}`,
			code: 1,
		};
	}
	return {
		ok: true,
		message: `Extension source (write to ${spec.locationLabel({})}):\n\n${PI_EXTENSION_SOURCE}`,
		code: 0,
	};
}

// fallow-ignore-next-line unused-export
export async function integrationUninstall(
	agent: string,
	opts: IntegrationInstallOptions = {},
): Promise<IntegrationResult> {
	const spec = specFor(agent);
	if (!spec) return rejectUnknownAgent(agent);
	const target = spec.target({ installDir: opts.installDir });
	if (!existsSync(target)) {
		return {
			ok: true,
			message: `nothing to uninstall (${target} absent)`,
			code: 0,
		};
	}
	try {
		rmSync(target);
	} catch {
		return {
			ok: false,
			message: `failed to remove ${target}`,
			code: 1,
		};
	}
	// Remove the extensions directory if it is now empty, so uninstall fully
	// cleans up after itself without clobbering unrelated files.
	const dir = dirname(target);
	if (existsSync(dir) && readdirSync(dir).length === 0) {
		try {
			rmSync(dir, { recursive: true });
		} catch {
			/* ignore: leave the empty dir if removal fails */
		}
	}
	return {
		ok: true,
		message: `uninstalled ${agent} integration (removed ${target})`,
		code: 0,
	};
}

/** CLI dispatch for `vp integration <subcommand> <agent>`. */
export async function runIntegration(
	sub: string,
	agent: string,
	installDir?: string,
): Promise<IntegrationResult> {
	switch (sub) {
		case "install":
			if (!agent) return { ok: false, message: "usage: vp integration install <agent>", code: 1 };
			return integrationInstall(agent, { installDir });
		case "show":
			if (!agent) return { ok: false, message: "usage: vp integration show <agent>", code: 1 };
			return integrationShow(agent);
		case "uninstall":
			if (!agent) return { ok: false, message: "usage: vp integration uninstall <agent>", code: 1 };
			return integrationUninstall(agent, { installDir });
		default:
			return {
				ok: false,
				message: `unknown integration subcommand "${sub ?? ""}". Try: install, show, uninstall`,
				code: 1,
			};
	}
}
