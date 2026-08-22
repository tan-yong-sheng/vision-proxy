/**
 * Stress tests for the crop pipeline (parse -> resolve -> sharp extract -> encode).
 *
 * These tests hammer the parts the existing unit tests only touch lightly:
 *   - every named region against multiple fixture sizes
 *   - normalized clamping at and beyond the 0..1 boundary
 *   - pixel clamping fully outside, partially outside, and at exact edges
 *   - zero-area and sub-pixel crops (should fail / null)
 *   - all supported image formats round-trip through cropImage
 *   - the full runAnalyze path with a crop that makes a 1x1 image
 *   - malformed --crop strings -> AnalyzeError
 *   - crop applied to the wrong image_index (no-op, not an error)
 *
 * Run:
 *   node --experimental-strip-types --no-warnings --test src/commands/crop-stress.test.ts
 */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { AnalyzeRequest, AnalyzeResponse } from "../adapter.ts";
import { resetCacheState } from "../cache.ts";
import {
	type CropEntry,
	clampPixels,
	cropImage,
	type NamedRegion,
	normalizedToPixels,
	parseCropArg,
	resolveRegion,
} from "../core.ts";
import { AnalyzeError, type AnalyzeFlags, type AnalyzeOutcome, runAnalyze } from "./analyze.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, "..", "..", "test", "fixtures");

let dir: string;
let prevCacheDir: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "vp-crop-"));
	prevCacheDir = process.env.VP_CACHE_DIR;
	process.env.VP_CACHE_DIR = dir;
	resetCacheState();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	if (prevCacheDir === undefined) delete process.env.VP_CACHE_DIR;
	else process.env.VP_CACHE_DIR = prevCacheDir;
});

after(() => {});

async function makeImage(
	w: number,
	h: number,
	opts: { rgba?: boolean; format?: keyof sharp.FormatEnum } = {},
): Promise<Buffer> {
	const { rgba = false, format = "png" } = opts;
	const channels = rgba ? 4 : 3;
	const background = rgba ? { r: 255, g: 0, b: 0, alpha: 128 } : { r: 0, g: 128, b: 255 };
	return sharp({
		create: { width: w, height: h, channels, background },
	})
		.toFormat(format)
		.toBuffer();
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

function stubAnalyze(text: string) {
	return async (req: AnalyzeRequest): Promise<AnalyzeResponse> => ({
		text: `${text}::q=${req.question}`,
	});
}

// ── Pure resolution stress ─────────────────────────────────────────────────

describe("normalizedToPixels boundary matrix", () => {
	it("full image {0,0,1,1} maps to exact dimensions", () => {
		for (const [w, h] of [
			[1, 1],
			[100, 100],
			[1920, 1080],
			[500, 500],
		]) {
			const r = normalizedToPixels({ x: 0, y: 0, width: 1, height: 1 }, w, h);
			assert.deepEqual(r, { x: 0, y: 0, width: w, height: h });
		}
	});

	it("half splits are exact on even dimensions", () => {
		const r = normalizedToPixels({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 100, 100);
		assert.deepEqual(r, { x: 50, y: 50, width: 50, height: 50 });
	});

	it("clamps out-of-bounds x/y to image edge, shrinking width/height accordingly", () => {
		// x=-0.5 -> start clamped to 0; x2 = round((-0.5+0.5)*100) = 0 -> width 0 -> null.
		const r = normalizedToPixels({ x: -0.5, y: -0.5, width: 0.5, height: 0.5 }, 100, 100);
		assert.equal(r, null);
	});

	it("clamps a partially-out-of-bounds rect and keeps the visible portion", () => {
		// x=-0.1 -> start=0; x2 = round((-0.1+0.5)*100) = 40 -> width 40.
		const r = normalizedToPixels({ x: -0.1, y: -0.1, width: 0.5, height: 0.5 }, 100, 100);
		assert.deepEqual(r, { x: 0, y: 0, width: 40, height: 40 });
	});

	it("clamps overflow width/height to the image edge", () => {
		const r = normalizedToPixels({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 100, 100);
		assert.equal(r!.x, 90);
		assert.equal(r!.y, 90);
		assert.equal(r!.x + r!.width, 100);
		assert.equal(r!.y + r!.height, 100);
	});

	it("returns null for fully degenerate rect (zero width)", () => {
		assert.equal(normalizedToPixels({ x: 0, y: 0, width: 0, height: 1 }, 100, 100), null);
	});

	it("returns null when clamping collapses to zero width", () => {
		// x=1.0 means start at the very right edge; width collapses to 0.
		const r = normalizedToPixels({ x: 1.0, y: 0, width: 0.5, height: 0.5 }, 100, 100);
		assert.equal(r, null);
	});

	it("returns null when clamping collapses to zero height", () => {
		const r = normalizedToPixels({ x: 0, y: 1.0, width: 0.5, height: 0.5 }, 100, 100);
		assert.equal(r, null);
	});

	it("sub-pixel rounding rounds, not truncates", () => {
		// 0.333 * 100 = 33.3 -> round -> 33
		const r = normalizedToPixels({ x: 0.333, y: 0, width: 0.333, height: 1 }, 100, 100);
		assert.equal(r!.x, 33);
	});
});

describe("clampPixels boundary matrix", () => {
	it("leaves an in-bounds rect untouched", () => {
		const r = clampPixels({ x: 10, y: 10, width: 50, height: 50 }, 100, 100);
		assert.deepEqual(r, { x: 10, y: 10, width: 50, height: 50 });
	});

	it("clamps negative origin to 0 and shrinks width to the visible portion", () => {
		// x=-10 -> clamped to 0; x2 = max(0, min(-10+50, 100)) = 40 -> width 40.
		const r = clampPixels({ x: -10, y: -10, width: 50, height: 50 }, 100, 100);
		assert.deepEqual(r, { x: 0, y: 0, width: 40, height: 40 });
	});

	it("clamps positive overflow back into the image", () => {
		const r = clampPixels({ x: 90, y: 90, width: 50, height: 50 }, 100, 100);
		assert.deepEqual(r, { x: 90, y: 90, width: 10, height: 10 });
	});

	it("clamps a fully-outside rect to zero area -> null", () => {
		const r = clampPixels({ x: 200, y: 200, width: 50, height: 50 }, 100, 100);
		assert.equal(r, null);
	});

	it("clamps a rect starting beyond the image to null", () => {
		const r = clampPixels({ x: 100, y: 100, width: 10, height: 10 }, 100, 100);
		assert.equal(r, null);
	});

	it("clamps a rect fully to the left to null", () => {
		const r = clampPixels({ x: -50, y: 0, width: 10, height: 10 }, 100, 100);
		assert.equal(r, null);
	});

	it("allows width=1 at the exact last pixel", () => {
		const r = clampPixels({ x: 99, y: 99, width: 1, height: 1 }, 100, 100);
		assert.deepEqual(r, { x: 99, y: 99, width: 1, height: 1 });
	});

	it("allows width=1 starting at 0 on a 1x1 image", () => {
		const r = clampPixels({ x: 0, y: 0, width: 1, height: 1 }, 1, 1);
		assert.deepEqual(r, { x: 0, y: 0, width: 1, height: 1 });
	});

	it("returns null for zero-dimension inputs", () => {
		assert.equal(clampPixels({ x: 0, y: 0, width: 0, height: 10 }, 100, 100), null);
		assert.equal(clampPixels({ x: 0, y: 0, width: 10, height: 0 }, 100, 100), null);
		assert.equal(clampPixels({ x: 0, y: 0, width: 0, height: 0 }, 100, 100), null);
	});
});

describe("resolveRegion covers all named regions with consistent fractions", () => {
	const ALL_REGIONS: NamedRegion[] = [
		"top-left",
		"top-right",
		"bottom-left",
		"bottom-right",
		"top",
		"bottom",
		"left",
		"right",
		"center",
		"top-half",
		"bottom-half",
		"left-half",
		"right-half",
	];

	for (const region of ALL_REGIONS) {
		it(`${region} produces a non-null, in-bounds crop on 100x100`, () => {
			const norm = resolveRegion(region);
			const r = normalizedToPixels(norm, 100, 100);
			assert.ok(r, `${region} collapsed to null on 100x100`);
			assert.ok(r!.x >= 0 && r!.y >= 0, `${region} has negative origin`);
			assert.ok(
				r!.x + r!.width <= 100 && r!.y + r!.height <= 100,
				`${region} exceeds bounds: ${JSON.stringify(r)}`,
			);
			assert.ok(r!.width > 0 && r!.height > 0, `${region} is degenerate`);
		});
	}

	it("top-half and top produce identical rects", () => {
		assert.deepEqual(resolveRegion("top"), resolveRegion("top-half"));
	});

	it("bottom-half and bottom produce identical rects", () => {
		assert.deepEqual(resolveRegion("bottom"), resolveRegion("bottom-half"));
	});

	it("left-half and left produce identical rects", () => {
		assert.deepEqual(resolveRegion("left"), resolveRegion("left-half"));
	});

	it("right-half and right produce identical rects", () => {
		assert.deepEqual(resolveRegion("right"), resolveRegion("right-half"));
	});
});

// ─--crop string parsing stress ──────────────────────────────────────────────

describe("parseCropArg malformed inputs", () => {
	it("rejects a missing colon", () => {
		const r = parseCropArg("center");
		assert.ok(typeof r === "string" && r.includes("Error"));
	});

	it("rejects a negative image index", () => {
		const r = parseCropArg("-1:r=center");
		assert.ok(typeof r === "string" && r.includes("Error"));
	});

	it("rejects a non-numeric image index", () => {
		const r = parseCropArg("abc:r=center");
		assert.ok(typeof r === "string" && r.includes("Error"));
	});

	it("rejects an unknown region", () => {
		const r = parseCropArg("0:r=middle");
		assert.ok(typeof r === "string" && r.includes("Error"));
	});

	it("rejects an unknown crop form prefix", () => {
		const r = parseCropArg("0:x=10,20,30,40");
		assert.ok(typeof r === "string" && r.includes("Error"));
	});

	it("rejects normalization with fewer than 4 numbers", () => {
		const r = parseCropArg("0:n=0.1,0.2,0.5");
		assert.ok(typeof r === "string" && r.includes("Error"));
	});

	it("rejects pixels with non-numeric values", () => {
		const r = parseCropArg("0:p=10,abc,30,40");
		assert.ok(typeof r === "string" && r.includes("Error"));
	});

	it("accepts extra whitespace-free numeric precision in normalized", () => {
		const r = parseCropArg("0:n=0.11111,0.22222,0.33333,0.44444");
		assert.ok(typeof r !== "string");
	});

	it("parses a large image index", () => {
		const r = parseCropArg("19:r=center");
		assert.deepEqual(r, { image_index: 19, region: "center" });
	});
});

// ── sharp cropImage round-trip stress ───────────────────────────────────────

describe("cropImage sharp round-trip", () => {
	it("crops a 100x100 PNG to its exact center and re-encodes PNG", async () => {
		const buf = await makeImage(100, 100, { format: "png" });
		const cropped = await cropImage(buf, { x: 25, y: 25, width: 50, height: 50 }, "image/png");
		assert.ok(cropped, "crop returned null unexpectedly");
		const meta = await sharp(cropped).metadata();
		assert.equal(meta.width, 50);
		assert.equal(meta.height, 50);
		assert.equal(meta.format, "png");
	});

	it("crops to 1x1 at the corner edge", async () => {
		const buf = await makeImage(100, 100, { format: "png" });
		const cropped = await cropImage(buf, { x: 99, y: 99, width: 1, height: 1 }, "image/png");
		assert.ok(cropped);
		const meta = await sharp(cropped).metadata();
		assert.equal(meta.width, 1);
		assert.equal(meta.height, 1);
	});

	it("crops JPEG input and re-encodes as JPEG (quality preserved)", async () => {
		const buf = await makeImage(100, 100, { format: "jpeg" });
		const cropped = await cropImage(buf, { x: 10, y: 10, width: 80, height: 80 }, "image/jpeg");
		assert.ok(cropped);
		const meta = await sharp(cropped).metadata();
		assert.equal(meta.width, 80);
		assert.equal(meta.height, 80);
		assert.equal(meta.format, "jpeg");
	});

	it("crops transparent WebP and re-encodes", async () => {
		const buf = await makeImage(100, 100, { rgba: true, format: "webp" });
		const cropped = await cropImage(buf, { x: 0, y: 0, width: 50, height: 50 }, "image/webp");
		assert.ok(cropped);
		const meta = await sharp(cropped).metadata();
		assert.equal(meta.width, 50);
		assert.equal(meta.height, 50);
	});

	it("crops TIFF input", async () => {
		const buf = await makeImage(100, 100, { format: "tiff" });
		const cropped = await cropImage(buf, { x: 20, y: 20, width: 60, height: 60 }, "image/tiff");
		// TIFF crop may or may not re-encode depending on sharp path, just ensure no null.
		assert.ok(cropped);
		const meta = await sharp(cropped).metadata();
		assert.equal(meta.width, 60);
		assert.equal(meta.height, 60);
	});

	it("returns null for a crop that sharp rejects (fully out of bounds)", async () => {
		const buf = await makeImage(100, 100, { format: "png" });
		// clampPixels would already null this, but call cropImage directly to test the catch.
		const r = await cropImage(buf, { x: 200, y: 200, width: 10, height: 10 }, "image/png");
		assert.equal(r, null);
	});

	it("returns null for a 0x0 crop region", async () => {
		const buf = await makeImage(100, 100, { format: "png" });
		const r = await cropImage(buf, { x: 0, y: 0, width: 0, height: 0 }, "image/png");
		assert.equal(r, null);
	});

	it("returns null when cropping a 1x1 image to a zero-area region", async () => {
		const buf = await makeImage(1, 1, { format: "png" });
		const r = await cropImage(buf, { x: 1, y: 1, width: 1, height: 1 }, "image/png");
		assert.equal(r, null);
	});

	it("keeps the cropped PNG byte-different from the full image (sanity)", async () => {
		const buf = await makeImage(100, 100, { format: "png" });
		const cropped = await cropImage(buf, { x: 0, y: 0, width: 50, height: 50 }, "image/png");
		assert.ok(cropped);
		assert.notEqual(cropped!.length, buf.length);
	});
});

// ── All named regions through cropImage via fixture-sized image ─────────────

describe("all named regions crop a 100x100 fixture-size PNG cleanly", () => {
	const regions: NamedRegion[] = [
		"top-left",
		"top-right",
		"bottom-left",
		"bottom-right",
		"top",
		"bottom",
		"left",
		"right",
		"center",
		"top-half",
		"bottom-half",
		"left-half",
		"right-half",
	];

	for (const region of regions) {
		it(`region=${region}`, async () => {
			const buf = await makeImage(100, 100, { format: "png" });
			const norm = resolveRegion(region);
			const px = normalizedToPixels(norm, 100, 100);
			assert.ok(px);
			const cropped = await cropImage(buf, px!, "image/png");
			assert.ok(cropped, `${region} produced null crop`);
			const meta = await sharp(cropped).metadata();
			assert.equal(meta.width, px!.width, `${region} width mismatch`);
			assert.equal(meta.height, px!.height, `${region} height mismatch`);
		});
	}
});

// ── Fixture-based crop across every supported format ────────────────────────

describe("cropImage across all fixture formats (region=center)", () => {
	// Sharp input formats that the fixtures exercise. BMP/ICO are not supported
	// as sharp *input* — they're covered separately in the analyze test suite.
	const cases = [
		{ file: "test.png", mime: "image/png" },
		{ file: "test.jpg", mime: "image/jpeg" },
		{ file: "test.jpeg", mime: "image/jpeg" },
		{ file: "test.gif", mime: "image/gif" },
		{ file: "test.webp", mime: "image/webp" },
		{ file: "test.tiff", mime: "image/tiff" },
		{ file: "test.tif", mime: "image/tiff" },
		{ file: "test.avif", mime: "image/avif" },
	];
	for (const { file, mime } of cases) {
		it(`crops ${file} (${mime}) center and produces a valid re-encoded buffer`, async () => {
			const buf = await readFile(path.join(FIXTURES_DIR, file));
			const cropped = await cropImage(buf, { x: 25, y: 25, width: 50, height: 50 }, mime);
			assert.ok(cropped, `${file} crop returned null`);
			const meta = await sharp(cropped).metadata();
			assert.equal(meta.width, 50);
			assert.equal(meta.height, 50);
		});
	}
});

// ── Full runAnalyze path with crops ─────────────────────────────────────────

describe("runAnalyze with crops end-to-end (stubbed model)", () => {
	it("crops a PNG with region=center and reaches the model", async () => {
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		const out: AnalyzeOutcome = await runAnalyze(
			[imgPath],
			baseFlags({ crops: [{ image_index: 0, region: "center" }] }),
			stubAnalyze("cropped"),
		);
		assert.equal(out.cacheHit, false);
		assert.ok(out.output.includes("cropped::q=what is this?"));
	});

	it("crops with normalized coordinates", async () => {
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		const out: AnalyzeOutcome = await runAnalyze(
			[imgPath],
			baseFlags({
				crops: [{ image_index: 0, normalized: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }],
			}),
			stubAnalyze("norm"),
		);
		assert.ok(out.output.includes("norm::q=what is this?"));
	});

	it("crops with pixel coordinates", async () => {
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		const out: AnalyzeOutcome = await runAnalyze(
			[imgPath],
			baseFlags({
				crops: [{ image_index: 0, pixels: { x: 10, y: 10, width: 80, height: 80 } }],
			}),
			stubAnalyze("px"),
		);
		assert.ok(out.output.includes("px::q=what is this?"));
	});

	it("a crop whose image_index does not match any payload silently skips the crop", async () => {
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		const out: AnalyzeOutcome = await runAnalyze(
			[imgPath],
			baseFlags({ crops: [{ image_index: 5, region: "center" }] }),
			stubAnalyze("nocrop"),
		);
		// image_index=5 doesn't match index 0, so the image is sent uncropped.
		assert.ok(out.output.includes("nocrop::q=what is this?"));
	});

	it("throws AnalyzeError when the crop region collapses to zero area", async () => {
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		await assert.rejects(
			() =>
				runAnalyze(
					[imgPath],
					baseFlags({
						crops: [{ image_index: 0, normalized: { x: 1, y: 1, width: 0, height: 0 } }],
					}),
					stubAnalyze("x"),
				),
			(e) => e instanceof AnalyzeError,
		);
	});

	it("throws AnalyzeError when a pixel crop is entirely outside the image", async () => {
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		await assert.rejects(
			() =>
				runAnalyze(
					[imgPath],
					baseFlags({
						crops: [{ image_index: 0, pixels: { x: 500, y: 500, width: 10, height: 10 } }],
					}),
					stubAnalyze("x"),
				),
			(e) => e instanceof AnalyzeError,
		);
	});

	it("crops two different images independently in one multi-image call", async () => {
		const a = path.join(FIXTURES_DIR, "test.png");
		const b = path.join(FIXTURES_DIR, "test.jpg");
		const out: AnalyzeOutcome = await runAnalyze(
			[a, b],
			baseFlags({
				joint: true,
				crops: [
					{ image_index: 0, region: "top-left" },
					{ image_index: 1, region: "bottom-right" },
				],
			}),
			stubAnalyze("two"),
		);
		assert.ok(out.output.startsWith("<vision_proxy_joint_description"));
		assert.ok(out.output.includes("two::q=what is this?"));
	});

	it("the same image+crop question is a cache hit on the second call", async () => {
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		const crops: CropEntry[] = [{ image_index: 0, region: "center" }];
		await runAnalyze([imgPath], baseFlags({ crops }), stubAnalyze("first"));
		let called = false;
		const out = await runAnalyze([imgPath], baseFlags({ crops }), async () => {
			called = true;
			return { text: "should-not-appear" };
		});
		assert.equal(called, false);
		assert.equal(out.cacheHit, true);
		assert.ok(out.output.includes("first::q=what is this?"));
	});

	it("different crop regions produce different cache keys (cache miss)", async () => {
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		await runAnalyze(
			[imgPath],
			baseFlags({ crops: [{ image_index: 0, region: "center" }] }),
			stubAnalyze("center-desc"),
		);
		const out = await runAnalyze(
			[imgPath],
			baseFlags({ crops: [{ image_index: 0, region: "top-left" }] }),
			stubAnalyze("topleft-desc"),
		);
		assert.equal(out.cacheHit, false);
		assert.ok(out.output.includes("topleft-desc::q=what is this?"));
	});

	it("a crop on a 1x1 image still produces a valid (degenerate-region rejected) outcome", async () => {
		// 1x1 with center = {0,0,1,1} round-trips fine; that's the minimal case.
		const tiny = path.join(dir, "tiny.png");
		await writeFile(tiny, await makeImage(1, 1, { format: "png" }));
		const out = await runAnalyze(
			[tiny],
			baseFlags({ crops: [{ image_index: 0, region: "center" }] }),
			stubAnalyze("tiny"),
		);
		assert.ok(out.output.includes("tiny::q=what is this?"));
	});
});

// ── parseCropFlags full parse -> runAnalyze path ───────────────────────────

describe("parseCropFlags -> runAnalyze with malformed --crop strings", () => {
	async function runWithRawCrop(raw: string[]): Promise<AnalyzeOutcome> {
		const { parseCropFlags } = await import("./analyze.ts");
		const { crops } = parseCropFlags({ crop: raw });
		const imgPath = path.join(FIXTURES_DIR, "test.png");
		return runAnalyze([imgPath], baseFlags({ crops }), stubAnalyze("ok"));
	}

	it("rejects a missing colon with AnalyzeError", async () => {
		await assert.rejects(
			() => runWithRawCrop(["center"]),
			(e) => e instanceof AnalyzeError,
		);
	});

	it("rejects an unknown region with AnalyzeError", async () => {
		await assert.rejects(
			() => runWithRawCrop(["0:r=middle"]),
			(e) => e instanceof AnalyzeError,
		);
	});

	it("rejects an unknown form prefix with AnalyzeError", async () => {
		await assert.rejects(
			() => runWithRawCrop(["0:z=1,2,3,4"]),
			(e) => e instanceof AnalyzeError,
		);
	});

	it("accepts multiple valid crops in one call", async () => {
		const a = path.join(FIXTURES_DIR, "test.png");
		const b = path.join(FIXTURES_DIR, "test.jpg");
		const out = await runAnalyze(
			[a, b],
			baseFlags({
				joint: true,
				crops: [
					{ image_index: 0, region: "center" },
					{ image_index: 1, normalized: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
				],
			}),
			stubAnalyze("multi"),
		);
		assert.ok(out.output.includes("multi::q=what is this?"));
	});
});
