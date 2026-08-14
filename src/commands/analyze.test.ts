/**
 * Integration tests for `vp analyze`.
 *
 * We inject a stub analyze implementation (the third arg of `runAnalyze`) so no
 * network call is made. A tiny valid PNG fixture is written to a temp dir. The
 * cache uses a temp dir via VP_CACHE_DIR.
 */
import { strict as assert } from "node:assert";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	runAnalyze,
	AnalyzeError,
	type AnalyzeFlags,
	type AnalyzeOutcome,
} from "./analyze.ts";
import { resetCacheState } from "../cache.ts";
import type { AnalyzeRequest, AnalyzeResponse } from "../adapter.ts";

// 1x1 transparent PNG.
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

let dir: string;
let imgPath: string;
let prevHome: string | undefined;

let prevCacheDir: string | undefined;

before(() => {
	prevCacheDir = process.env.VP_CACHE_DIR;
});

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "vp-an-"));
	imgPath = path.join(dir, "img.png");
	await writeFile(imgPath, Buffer.from(PNG_B64, "base64"));
	process.env.VP_CACHE_DIR = dir;
	prevHome = process.env.HOME;
	process.env.HOME = dir;
	resetCacheState();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
});

after(() => {
	if (prevCacheDir === undefined) delete process.env.VP_CACHE_DIR;
	else process.env.VP_CACHE_DIR = prevCacheDir;
});

function stubAnalyze(text: string) {
	return async (req: AnalyzeRequest): Promise<AnalyzeResponse> => {
		// Echo a marker so we can assert the question is forwarded.
		return { text: `${text}::q=${req.question}` };
	};
}

function baseFlags(extra: Partial<AnalyzeFlags> = {}): AnalyzeFlags {
	return {
		fence: true,
		json: false,
		question: "what is this?",
		env: {
			OPENAI_API_KEY: "sk-test",
			ANTHROPIC_API_KEY: "sk-test",
		} as NodeJS.ProcessEnv,
		cwd: dir,
		...extra,
	};
}

describe("runAnalyze single-image cache-first", () => {
	it("calls the model on a miss and emits a fenced description by default", async () => {
		const out: AnalyzeOutcome = await runAnalyze([imgPath], baseFlags(), stubAnalyze("desc"));
		assert.equal(out.cacheHit, false);
		assert.ok(out.output.startsWith("<vision_proxy_description"));
		assert.ok(out.output.includes("desc::q=what is this?"));
	});

	it("returns a cache hit without calling the model again", async () => {
		await runAnalyze([imgPath], baseFlags(), stubAnalyze("first"));
		let called = false;
		const out: AnalyzeOutcome = await runAnalyze(
			[imgPath],
			baseFlags(),
			async () => {
				called = true;
				return { text: "should-not-appear" };
			},
		);
		assert.equal(out.cacheHit, true);
		assert.equal(called, false);
		assert.ok(out.output.includes("first::q=what is this?"));
	});

	it("--no-fence drops the fence and returns raw description", async () => {
		const out: AnalyzeOutcome = await runAnalyze(
			[imgPath],
			baseFlags({ fence: false, question: "unfenced question" }),
			stubAnalyze("raw"),
		);
		assert.equal(out.cacheHit, false);
		assert.ok(!out.output.startsWith("<vision_proxy_description"));
		assert.equal(out.output, "raw::q=unfenced question");
	});

	it("throws AnalyzeError on an unknown provider", async () => {
		await assert.rejects(
			() => runAnalyze([imgPath], baseFlags({ provider: "bogus" }), stubAnalyze("x")),
			(e) => e instanceof AnalyzeError,
		);
	});

	it("throws AnalyzeError when no API key is available", async () => {
		await assert.rejects(
			() =>
				runAnalyze(
					[imgPath],
					baseFlags({ env: { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } as NodeJS.ProcessEnv }),
					stubAnalyze("x"),
				),
			(e) => e instanceof AnalyzeError,
		);
	});
});

describe("runAnalyze joint / multi-image", () => {
	it("emits a joint fence for multiple images", async () => {
		const out: AnalyzeOutcome = await runAnalyze(
			[imgPath, imgPath],
			baseFlags({ joint: true }),
			stubAnalyze("joint"),
		);
		assert.ok(out.output.startsWith("<vision_proxy_joint_description"));
		assert.ok(out.output.includes("joint::q=what is this?"));
	});
});

describe("parseCropFlags", () => {
	it("parses repeatable --crop flags from the flags map", async () => {
		const { parseCropFlags } = await import("./analyze.ts");
		const { crops } = parseCropFlags({ crop: ["0:r=center", "1:n=0.1,0.2,0.5,0.5"] });
		assert.ok(crops);
		assert.equal(crops.length, 2);
		assert.deepEqual(crops[0], { image_index: 0, region: "center" });
	});
});
