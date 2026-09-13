/**
 * Seam tests for the analysis module (`src/analysis/`).
 *
 * Pins the extracted boundary: `src/commands/analyze.ts` is thin wiring over
 * `src/analysis/`, so the command surface must be referentially identical to
 * the module surface, and the module must preserve the coordination error
 * behavior (image limits, unknown providers, malformed crops) without
 * reaching the model.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AnalyzeRequest, AnalyzeResponse } from "../adapter.ts";
import { resetCacheState } from "../cache.ts";
import * as command from "../commands/analyze.ts";
import * as analysis from "./index.ts";

let dir: string;
let prevCacheDir: string | undefined;
let prevHome: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "vp-analysis-seam-"));
	prevCacheDir = process.env.VP_CACHE_DIR;
	process.env.VP_CACHE_DIR = dir;
	prevHome = process.env.HOME;
	process.env.HOME = dir;
	resetCacheState();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	if (prevCacheDir === undefined) delete process.env.VP_CACHE_DIR;
	else process.env.VP_CACHE_DIR = prevCacheDir;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	resetCacheState();
});

function neverAnalyze(): (req: AnalyzeRequest) => Promise<AnalyzeResponse> {
	return async () => {
		throw new Error("model must not be called");
	};
}

const TEST_ENV = {
	OPENAI_API_KEY: "sk-test",
	ANTHROPIC_API_KEY: "sk-test",
} as NodeJS.ProcessEnv;

describe("analysis module seam", () => {
	it("re-exports the stable command surface by identity", () => {
		assert.equal(analysis.runAnalyze, command.runAnalyze);
		assert.equal(analysis.parseCropFlags, command.parseCropFlags);
		assert.equal(analysis.AnalyzeError, command.AnalyzeError);
	});

	it("enforces the image limit before reading any image", async () => {
		const paths = Array.from({ length: 100 }, (_, i) => `missing-${i}.png`);
		await assert.rejects(
			() =>
				analysis.runAnalyze(
					paths,
					{ fence: true, json: false, env: TEST_ENV, cwd: dir },
					neverAnalyze(),
				),
			(e) => e instanceof analysis.AnalyzeError && /too many images \(100\)/.test(e.message),
		);
	});

	it("rejects unknown providers with AnalyzeError without calling the model", async () => {
		await assert.rejects(
			() =>
				analysis.runAnalyze(
					["img.png"],
					{ fence: true, json: false, provider: "bogus", env: TEST_ENV, cwd: dir },
					neverAnalyze(),
				),
			(e) => e instanceof analysis.AnalyzeError && /unknown provider "bogus"/.test(e.message),
		);
	});

	it("rejects missing keys with AnalyzeError without calling the model", async () => {
		await assert.rejects(
			() =>
				analysis.runAnalyze(
					["img.png"],
					{ fence: true, json: false, provider: "openai", env: {}, cwd: dir },
					neverAnalyze(),
				),
			(e) => e instanceof analysis.AnalyzeError && /no API key/.test(e.message),
		);
	});

	it("parseCropFlags rejects malformed crops with AnalyzeError", () => {
		assert.deepEqual(analysis.parseCropFlags({}), { crops: undefined });
		assert.throws(() => analysis.parseCropFlags({ crop: "bogus" }), analysis.AnalyzeError);
	});
});
