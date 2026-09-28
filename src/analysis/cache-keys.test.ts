/**
 * Golden cache-key tests for the analysis pipeline (`src/analysis/pipeline.ts`).
 *
 * Pins the EXACT `buildToolCacheKey` strings produced by the single-image and
 * joint multi-image cache paths, including the effective grounding format
 * segment (`&f=<format>`). The format segment is intentional: the same
 * image+question analyzed under different `--format` values renders a
 * different fence, so those results must NOT share a cache entry.
 *
 * Key shape: `<hashes>[#crop:<sig>]?q=<promptHash>&m=<model>&f=<format>`
 *   - single: cropSig is `cropSignature(p.crop)` or absent.
 *   - joint: cropSig is per-image `cropSignature | "full"` joined with "+",
 *     prefixed with `joint:` when `--joint` is set.
 *   - format: the effective grounding format (`flags.format` override or the
 *     provider/model default from `getGroundingFormat`; `none` by default).
 */
import { strict as assert } from "node:assert";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AnalyzeResponse } from "../adapter.ts";
import { resetCacheState } from "../cache.ts";
import { runAnalyze } from "./pipeline.ts";
import type { AnalyzeFlags } from "./types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// test/fixtures holds real decodable images (1x1 PNGs fail the crop path).
const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures");

let dir: string;
let imgPng: string;
let imgJpg: string;
let prevCacheDir: string | undefined;
let prevHome: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "vp-cache-keys-"));
	imgPng = path.join(dir, "a.png");
	imgJpg = path.join(dir, "b.jpg");
	await copyFile(path.join(FIXTURES, "test.png"), imgPng);
	await copyFile(path.join(FIXTURES, "test.jpg"), imgJpg);
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

const TEST_ENV = { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv;

function baseFlags(extra: Partial<AnalyzeFlags> = {}): AnalyzeFlags {
	return {
		fence: true,
		json: false,
		question: "what is this?",
		env: TEST_ENV,
		cwd: dir,
		...extra,
	};
}

async function stub() {
	return { text: "desc" } as AnalyzeResponse;
}

/** Run analyze once (cache miss) and return the exact cache keys written. */
async function keysFor(paths: string[], flags: AnalyzeFlags): Promise<string[]> {
	await runAnalyze(paths, flags, stub);
	const raw = await readFile(path.join(dir, "cache.json"), "utf8");
	return Object.keys(JSON.parse(raw) as Record<string, unknown>).sort();
}

// Golden constants (pinned 2026-09-28; fixtures test.png / test.jpg):
const H_PNG = "45467f2330012f79e745eac614c6147f"; // test.png payload hash
const H_JPG = "2db792908ecb701db854a3aefe2f89b0"; // test.jpg payload hash
const H_CROP = "db5d87820c9c378039ea47d25118e114"; // test.png center-cropped hash
const CROP_SIG = "25,25,50,50"; // center region of test.png
const PROMPT_HASH = "2720fde6d70c7a5cda6eb207816c2556"; // q="what is this?", no context
const MODEL = "anthropic/claude-sonnet-4-5"; // default config
const FORMAT_NONE = "none"; // default effective format (no grounding override)

describe("pipeline cache-key goldens", () => {
	it("single uncropped omits the crop segment", async () => {
		assert.deepEqual(await keysFor([imgPng], baseFlags()), [
			`${H_PNG}?q=${PROMPT_HASH}&m=${MODEL}&f=${FORMAT_NONE}`,
		]);
	});

	it("single cropped pins hash + crop signature", async () => {
		assert.deepEqual(
			await keysFor([imgPng], baseFlags({ crops: [{ image_index: 0, region: "center" }] })),
			[`${H_CROP}#crop:${CROP_SIG}?q=${PROMPT_HASH}&m=${MODEL}&f=${FORMAT_NONE}`],
		);
	});

	it("joint multi without --joint uses full+full sig, no joint prefix", async () => {
		assert.deepEqual(await keysFor([imgPng, imgJpg], baseFlags()), [
			`${H_PNG}+${H_JPG}#crop:full+full?q=${PROMPT_HASH}&m=${MODEL}&f=${FORMAT_NONE}`,
		]);
	});

	it("joint multi with --joint prefixes joint:", async () => {
		assert.deepEqual(await keysFor([imgPng, imgJpg], baseFlags({ joint: true })), [
			`${H_PNG}+${H_JPG}#crop:joint:full+full?q=${PROMPT_HASH}&m=${MODEL}&f=${FORMAT_NONE}`,
		]);
	});

	it("joint flag on a single image keys joint:full", async () => {
		assert.deepEqual(await keysFor([imgPng], baseFlags({ joint: true })), [
			`${H_PNG}#crop:joint:full?q=${PROMPT_HASH}&m=${MODEL}&f=${FORMAT_NONE}`,
		]);
	});

	it("joint mixed crop without --joint joins per-image sigs", async () => {
		assert.deepEqual(
			await keysFor([imgPng, imgJpg], baseFlags({ crops: [{ image_index: 0, region: "center" }] })),
			[`${H_CROP}+${H_JPG}#crop:${CROP_SIG}+full?q=${PROMPT_HASH}&m=${MODEL}&f=${FORMAT_NONE}`],
		);
	});

	it("joint mixed crop with --joint prefixes joint:", async () => {
		assert.deepEqual(
			await keysFor(
				[imgPng, imgJpg],
				baseFlags({ joint: true, crops: [{ image_index: 0, region: "center" }] }),
			),
			[
				`${H_CROP}+${H_JPG}#crop:joint:${CROP_SIG}+full?q=${PROMPT_HASH}&m=${MODEL}&f=${FORMAT_NONE}`,
			],
		);
	});

	it("same image+question under different --format keys different entries", async () => {
		const noneKeys = await keysFor([imgPng], baseFlags());
		await rm(`${dir}/cache.json`, { force: true });
		resetCacheState();
		const qwenKeys = await keysFor([imgPng], baseFlags({ format: "qwen_pixels" }));
		assert.deepEqual(noneKeys, [`${H_PNG}?q=${PROMPT_HASH}&m=${MODEL}&f=none`]);
		assert.deepEqual(qwenKeys, [`${H_PNG}?q=${PROMPT_HASH}&m=${MODEL}&f=qwen_pixels`]);
	});
});
