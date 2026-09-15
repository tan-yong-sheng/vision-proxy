/**
 * Analysis command surface types.
 *
 * Owned by the analysis module (`src/analysis/`); `src/commands/analyze.ts`
 * re-exports this so CLI and test imports keep working.
 */

import type { CropEntry, GroundingFormat } from "../core.ts";

export interface AnalyzeFlags {
	format?: GroundingFormat;
	provider?: string;
	model?: string;
	joint?: boolean;
	crops?: CropEntry[];
	fence: boolean;
	configPath?: string;
	json: boolean;
	maxOutputTokens?: number;
	question?: string;
	context?: string;
	apiKey?: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

export interface AnalyzeOutcome {
	/** Text printed to stdout (fenced or plain). */
	output: string;
	/** Whether the result came from cache. */
	cacheHit: boolean;
	/** Per-image records for --json. */
	records: Array<{ hash: string; description: string; error?: string }>;
}
