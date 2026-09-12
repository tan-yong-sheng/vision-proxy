/**
 * `vp integration` — thin command wiring over the integrations module.
 *
 * Host catalog (paths, generated sources, legacy cleanups) lives in
 * `src/integrations/catalog.ts`, the shared hooks-JSON shape in
 * `src/integrations/hooks-config.ts`, and install/show/list/status/uninstall
 * orchestration in `src/integrations/lifecycle.ts`. This module only
 * re-exports that surface so `src/cli.ts` keeps a stable import path.
 */

export type { IntegrationInstallOptions, IntegrationResult } from "../integrations/index.ts";
export {
	integrationInstall,
	integrationList,
	integrationShow,
	integrationStatus,
	integrationUninstall,
	runIntegration,
} from "../integrations/index.ts";
