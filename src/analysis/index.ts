/**
 * Analysis module public surface.
 *
 * `src/commands/analyze.ts` re-exports this module so existing CLI and test
 * imports keep working while the coordination flow (config resolution, image
 * intake/read/hash/crop, cache policy, provider/model dispatch, safe
 * rendering) lives in `pipeline.ts`. `core.ts`, `config.ts`, `cache.ts`,
 * `adapter.ts`, and `provider.ts` remain the focused implementation files.
 */

export { AnalyzeError, parseCropFlags, runAnalyze } from "./pipeline.ts";
export type { AnalyzeFlags, AnalyzeOutcome } from "./types.ts";
