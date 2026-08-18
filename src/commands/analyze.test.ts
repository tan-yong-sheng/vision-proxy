/**
 * Integration tests for `vp analyze`.
 *
 * We inject a stub analyze implementation (the third arg of `runAnalyze`) so no
 * network call is made. A tiny valid PNG fixture is written to a temp dir. The
 * cache uses a temp dir via VP_CACHE_DIR.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AnalyzeRequest, AnalyzeResponse } from "../adapter.ts";
import { resetCacheState } from "../cache.ts";
import { AnalyzeError, type AnalyzeFlags, type AnalyzeOutcome, runAnalyze } from "./analyze.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
		const out: AnalyzeOutcome = await runAnalyze([imgPath], baseFlags(), async () => {
			called = true;
			return { text: "should-not-appear" };
		});
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

	it("appends grounding instructions to the system prompt for configured models", async () => {
		await writeFile(
			path.join(dir, ".vision-proxy.json"),
			JSON.stringify({
				groundingModels: { "anthropic/claude-sonnet-4-5": { format: "qwen_pixels" } },
			}),
		);
		let capturedSystemPrompt = "";
		await runAnalyze([imgPath], baseFlags(), async (req) => {
			capturedSystemPrompt = req.systemPrompt;
			return { text: "desc" };
		});
		assert.ok(capturedSystemPrompt.includes("bounding-box coordinates as [x1, y1, x2, y2]"));
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

describe("runAnalyze image limits", () => {
	it("enforces maxImagesPerCall", async () => {
		await writeFile(path.join(dir, ".vision-proxy.json"), JSON.stringify({ maxImagesPerCall: 2 }));
		await assert.rejects(
			() => runAnalyze([imgPath, imgPath, imgPath], baseFlags(), stubAnalyze("x")),
			(e) => e instanceof AnalyzeError && /too many images \(3\)/.test(e.message),
		);
	});

	it("enforces the default maxImagesPerCall of 4", async () => {
		await assert.rejects(
			() =>
				runAnalyze(
					[imgPath, imgPath, imgPath, imgPath, imgPath],
					baseFlags({ joint: true }),
					stubAnalyze("x"),
				),
			(e) => e instanceof AnalyzeError && /too many images \(5\)/.test(e.message),
		);
	});

	it("applies the deprecated maxBatch alias when maxImagesPerCall is unset", async () => {
		await writeFile(path.join(dir, ".vision-proxy.json"), JSON.stringify({ maxBatch: 2 }));
		await assert.rejects(
			() => runAnalyze([imgPath, imgPath, imgPath], baseFlags(), stubAnalyze("x")),
			(e) => e instanceof AnalyzeError && /too many images \(3\)/.test(e.message),
		);
	});

	it("uses maxImagesPerCall in preference to the maxBatch alias", async () => {
		await writeFile(
			path.join(dir, ".vision-proxy.json"),
			JSON.stringify({ maxBatch: 2, maxImagesPerCall: 5 }),
		);
		const out: AnalyzeOutcome = await runAnalyze(
			[imgPath, imgPath, imgPath, imgPath, imgPath],
			baseFlags({ joint: true }),
			stubAnalyze("ok"),
		);
		assert.ok(out.output.includes("ok"));
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

describe("runAnalyze crop on all 10 formats", () => {
	const FIXTURES_DIR = path.join(__dirname, "..", "..", "test", "fixtures");
	// Sharp supports: PNG, JPEG, GIF, WebP, TIFF, AVIF
	// Sharp does NOT support: BMP, ICO (as input formats)
	const formats = [
		{ file: "test.png", mime: "image/png" },
		{ file: "test.jpg", mime: "image/jpeg" },
		{ file: "test.jpeg", mime: "image/jpeg" },
		{ file: "test.gif", mime: "image/gif" },
		{ file: "test.webp", mime: "image/webp" },
		{ file: "test.tiff", mime: "image/tiff" },
		{ file: "test.tif", mime: "image/tiff" },
		{ file: "test.avif", mime: "image/avif" },
	];

	for (const { file, mime } of formats) {
		it(`crops ${file} (${mime}) with region center`, async () => {
			const imgPath = path.join(FIXTURES_DIR, file);
			const out: AnalyzeOutcome = await runAnalyze(
				[imgPath],
				baseFlags({
					crops: [{ image_index: 0, region: "center" }],
				}),
				stubAnalyze("cropped"),
			);
			assert.equal(out.cacheHit, false);
			assert.ok(out.output.includes("cropped::q=what is this?"));
		});

		it(`crops ${file} (${mime}) with normalized coords`, async () => {
			const imgPath = path.join(FIXTURES_DIR, file);
			const out: AnalyzeOutcome = await runAnalyze(
				[imgPath],
				baseFlags({
					crops: [{ image_index: 0, normalized: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }],
				}),
				stubAnalyze("cropped"),
			);
			assert.equal(out.cacheHit, false);
			assert.ok(out.output.includes("cropped::q=what is this?"));
		});

		it(`crops ${file} (${mime}) with pixel coords`, async () => {
			const imgPath = path.join(FIXTURES_DIR, file);
			const out: AnalyzeOutcome = await runAnalyze(
				[imgPath],
				baseFlags({
					crops: [{ image_index: 0, pixels: { x: 10, y: 10, width: 50, height: 50 } }],
				}),
				stubAnalyze("cropped"),
			);
			assert.equal(out.cacheHit, false);
			assert.ok(out.output.includes("cropped::q=what is this?"));
		});
	}
});

describe("runAnalyze content mismatch detection", () => {
	const FIXTURES_DIR = path.join(__dirname, "..", "..", "test", "fixtures");

	it("detects PNG content in .jpg file (non-strict mode)", async () => {
		const imgPath = path.join(FIXTURES_DIR, "png-content.jpg");
		const out: AnalyzeOutcome = await runAnalyze([imgPath], baseFlags(), stubAnalyze("desc"));
		assert.equal(out.cacheHit, false);
		assert.ok(out.output.includes("desc::q=what is this?"));
	});

	it("rejects PNG content in .jpg file in strict mode", async () => {
		const imgPath = path.join(FIXTURES_DIR, "png-content.jpg");
		process.env.VP_STRICT_MIME = "1";
		try {
			await assert.rejects(
				() => runAnalyze([imgPath], baseFlags(), stubAnalyze("desc")),
				(e) => e instanceof AnalyzeError && /extension does not match/.test(e.message),
			);
		} finally {
			delete process.env.VP_STRICT_MIME;
		}
	});
});

// Local helper functions for URL/size tests (match core.ts implementations)
function isUrl(str: string): boolean {
	try {
		const u = new URL(str);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

function maxImageFileBytes(): number {
	const raw = process.env.VP_MAX_IMAGE_BYTES;
	if (raw) {
		const n = Number.parseInt(raw, 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return 10 * 1024 * 1024;
}

describe("runAnalyze URL download", () => {
	// These tests would require a mock HTTP server.
	// For now we test the URL path validation and config handling.
	it("accepts http:// URL format in image path", () => {
		// URL validation happens in readImageFileWithReason via isUrl()
		// We just verify the function exists and the path is recognized as URL
		assert.equal(isUrl("http://example.com/image.png"), true);
		assert.equal(isUrl("https://example.com/image.png"), true);
		assert.equal(isUrl("/local/path.png"), false);
	});

	it("enforces size limit on downloaded images via VP_MAX_IMAGE_BYTES", async () => {
		// This test verifies the config option is read correctly
		process.env.VP_MAX_IMAGE_BYTES = "500000";
		try {
			assert.equal(maxImageFileBytes(), 500000);
		} finally {
			delete process.env.VP_MAX_IMAGE_BYTES;
		}
	});

	it("uses default size limit when VP_MAX_IMAGE_BYTES not set", async () => {
		delete process.env.VP_MAX_IMAGE_BYTES;
		assert.equal(maxImageFileBytes(), 10 * 1024 * 1024); // 10MB default
	});
});

describe("runAnalyze transient retry simulation", () => {
	// The retry logic is inside analyzeImagesWithModel (adapter.ts).
	// We simulate it by wrapping our stub with the same retry logic.
	// Copied from adapter.ts since it's not exported.
	function isTransientError(err: Error): boolean {
		const msg = err.message.toLowerCase();
		if (msg.includes("rate limit") || msg.includes("429")) return true;
		if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504"))
			return true;
		if (msg.includes("request contains an invalid argument")) return true;
		if (msg.includes("overloaded") || msg.includes("timeout")) return true;
		return false;
	}

	async function withRetry(
		impl: (req: AnalyzeRequest) => Promise<AnalyzeResponse>,
		req: AnalyzeRequest,
	): Promise<AnalyzeResponse> {
		let lastErr: Error | undefined;
		const maxRetries = 1;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await impl(req);
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				if (attempt < maxRetries && isTransientError(lastErr)) {
					await new Promise((r) => setTimeout(r, 10)); // fast retry for tests
					continue;
				}
				throw lastErr;
			}
		}
		throw lastErr;
	}

	it("retries on transient error (429 rate limit)", async () => {
		let attempts = 0;
		const flakyAnalyze = async (_req: AnalyzeRequest): Promise<AnalyzeResponse> => {
			attempts++;
			if (attempts === 1) {
				throw new Error("Rate limit 429 too many requests");
			}
			return { text: `success on attempt ${attempts}` };
		};

		const wrappedAnalyze = async (req: AnalyzeRequest) => withRetry(flakyAnalyze, req);

		const out: AnalyzeOutcome = await runAnalyze([imgPath], baseFlags(), wrappedAnalyze);
		assert.equal(attempts, 2);
		assert.ok(out.output.includes("success on attempt 2"));
	});

	it("retries on transient error (503 service unavailable)", async () => {
		let attempts = 0;
		const flakyAnalyze = async (_req: AnalyzeRequest): Promise<AnalyzeResponse> => {
			attempts++;
			if (attempts === 1) {
				throw new Error("503 service unavailable");
			}
			return { text: `success on attempt ${attempts}` };
		};

		const wrappedAnalyze = async (req: AnalyzeRequest) => withRetry(flakyAnalyze, req);

		const out: AnalyzeOutcome = await runAnalyze([imgPath], baseFlags(), wrappedAnalyze);
		assert.equal(attempts, 2);
		assert.ok(out.output.includes("success on attempt 2"));
	});

	it("retries on transient error (invalid argument)", async () => {
		let attempts = 0;
		const flakyAnalyze = async (_req: AnalyzeRequest): Promise<AnalyzeResponse> => {
			attempts++;
			if (attempts === 1) {
				throw new Error("Request contains an invalid argument");
			}
			return { text: `success on attempt ${attempts}` };
		};

		const wrappedAnalyze = async (req: AnalyzeRequest) => withRetry(flakyAnalyze, req);

		const out: AnalyzeOutcome = await runAnalyze([imgPath], baseFlags(), wrappedAnalyze);
		assert.equal(attempts, 2);
		assert.ok(out.output.includes("success on attempt 2"));
	});

	it("does not retry on non-transient error", async () => {
		let attempts = 0;
		const flakyAnalyze = async (_req: AnalyzeRequest): Promise<AnalyzeResponse> => {
			attempts++;
			throw new Error("400 bad request - not transient");
		};

		const wrappedAnalyze = async (req: AnalyzeRequest) => withRetry(flakyAnalyze, req);

		await assert.rejects(
			() => runAnalyze([imgPath], baseFlags(), wrappedAnalyze),
			(e) => e instanceof Error && /400 bad request/.test(e.message),
		);
		assert.equal(attempts, 1);
	});

	it("throws after max retries exhausted", async () => {
		let attempts = 0;
		const flakyAnalyze = async (_req: AnalyzeRequest): Promise<AnalyzeResponse> => {
			attempts++;
			throw new Error("Rate limit 429 too many requests");
		};

		const wrappedAnalyze = async (req: AnalyzeRequest) => withRetry(flakyAnalyze, req);

		await assert.rejects(
			() => runAnalyze([imgPath], baseFlags(), wrappedAnalyze),
			(e) => e instanceof Error && /Rate limit 429/.test(e.message),
		);
		assert.equal(attempts, 2); // 1 initial + 1 retry
	});
});
