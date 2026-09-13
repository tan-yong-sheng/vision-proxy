/**
 * `vp analyze` — thin command wiring over the analysis module.
 *
 * The coordination flow (config resolution, image intake/read/hash/crop,
 * cache-first single + joint multi-image policy, provider/model dispatch,
 * safe fenced rendering) lives in `src/analysis/pipeline.ts`; the surface
 * types live in `src/analysis/types.ts`. This module only re-exports that
 * surface so `src/cli.ts` and existing tests keep a stable import path.
 */

export type { AnalyzeFlags, AnalyzeOutcome } from "../analysis/index.ts";
export { AnalyzeError, parseCropFlags, runAnalyze } from "../analysis/index.ts";
