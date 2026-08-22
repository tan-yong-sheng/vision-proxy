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
import { analyzeImagesWithModel } from "../adapter.ts";
import { resetCacheState } from "../cache.ts";
import { readImageFileWithReason } from "../core.ts";
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

// Stub the global fetch so readImageFileWithReason exercises the real URL
// download, content-type parsing, size-limit check, and content sniffing paths
// without touching the network.
function stubFetch(body: Uint8Array, headers: Record<string, string>, ok = true) {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => {
		return {
			ok,
			status: ok ? 200 : 500,
			body: {
				getReader: () => {
					let done = false;
					return {
						read: async () => {
							if (done) return { done: true, value: undefined };
							done = true;
							return { done: false, value: body };
						},
					};
				},
			},
			headers: {
				get: (k: string) => headers[k.toLowerCase()] ?? null,
			},
		} as unknown as Response;
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

describe("readImageFileWithReason URL download", () => {
	it("downloads a PNG URL and returns the sniffed mime type", async () => {
		const png = Buffer.from(PNG_B64, "base64");
		const restore = stubFetch(png, { "content-type": "image/png" });
		try {
			const res = await readImageFileWithReason("http://93.184.216.34/image.png");
			assert.ok(res.image);
			assert.equal(res.image?.mimeType, "image/png");
		} finally {
			restore();
		}
	});

	it("rejects non-image URLs via isUrl", async () => {
		// Local paths never enter the URL branch.
		const res = await readImageFileWithReason("/local/path.png");
		assert.equal(res.image, null);
	});

	it("rejects restricted/internal hosts (SSRF protection) without fetching", async () => {
		// Loopback, metadata service, and private ranges are blocked before any fetch.
		// We stub fetch to count calls so a regression can't silently emit a request
		// to 127.0.0.1 / 169.254.169.254 / 10.x / 192.168.x.
		const blocked = [
			"http://127.0.0.1/image.png",
			"http://localhost/image.png",
			"http://169.254.169.254/latest/meta-data/",
			"http://10.0.0.5/secret.png",
			"http://192.168.1.1/router.png",
		];
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls++;
			return {
				ok: true,
				status: 200,
				body: null,
				headers: { get: () => null },
			} as unknown as Response;
		}) as typeof fetch;
		try {
			for (const url of blocked) {
				const res = await readImageFileWithReason(url);
				assert.equal(res.image, null, `expected ${url} to be blocked`);
				// Blocked hosts must be reported as "denied", not "not-found".
				assert.equal(res.reason, "denied", `expected ${url} to report "denied"`);
			}
			assert.equal(calls, 0, "no fetch should be made for blocked hosts");
		} finally {
			globalThis.fetch = original;
		}
	});

	it("rejects IPv6 literal restricted addresses (SSRF protection) without fetching", async () => {
		// IPv6 literals with brackets: loopback, link-local (full fe80::/10),
		// site-local, unique-local are blocked.
		const blocked = [
			"http://[::1]/image.png",
			"http://[fe80::1]/image.png",
			"http://[febf::1]/image.png",
			"http://[fec0::1]/image.png",
			"http://[fc00::1]/image.png",
			"http://[fd12:3456::1]/image.png",
		];
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls++;
			return {
				ok: true,
				status: 200,
				body: null,
				headers: { get: () => null },
			} as unknown as Response;
		}) as typeof fetch;
		try {
			for (const url of blocked) {
				const res = await readImageFileWithReason(url);
				assert.equal(res.image, null, `expected ${url} to be blocked`);
				assert.equal(res.reason, "denied", `expected ${url} to report "denied"`);
			}
			assert.equal(calls, 0, "no fetch should be made for blocked IPv6 hosts");
		} finally {
			globalThis.fetch = original;
		}
	});

	it("rejects IPv4-mapped and unspecified IPv6 forms (SSRF protection)", async () => {
		// ::ffff:127.0.0.1 embeds a loopback IPv4; :: is the unspecified address.
		// Both must be blocked even though they are not plain dotted-quad / ::1.
		const blocked = [
			"http://[::ffff:127.0.0.1]/image.png",
			"http://[::ffff:10.0.0.5]/image.png",
			"http://[::ffff:169.254.169.254]/image.png",
			"http://[::]/image.png",
		];
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls++;
			return {
				ok: true,
				status: 200,
				body: null,
				headers: { get: () => null },
			} as unknown as Response;
		}) as typeof fetch;
		try {
			for (const url of blocked) {
				const res = await readImageFileWithReason(url);
				assert.equal(res.image, null, `expected ${url} to be blocked`);
				assert.equal(res.reason, "denied", `expected ${url} to report "denied"`);
			}
			assert.equal(calls, 0, "no fetch should be made for IPv4-mapped hosts");
		} finally {
			globalThis.fetch = original;
		}
	});

	it("allows public IPv6 literal addresses", async () => {
		// Public IPv6 literals should be allowed (would proceed to fetch).
		// We verify they pass SSRF validation by mocking a successful fetch.
		const png = Buffer.from(PNG_B64, "base64");
		const restore = stubFetch(png, { "content-type": "image/png" });
		try {
			const allowed = [
				"http://[2001:db8::1]/image.png", // documentation prefix
				"http://[2606:4700:4700::1111]/image.png", // Cloudflare DNS
				"http://[::1:1]/image.png", // global unicast, not loopback ::1
			];
			for (const url of allowed) {
				const res = await readImageFileWithReason(url);
				assert.equal(res.image !== null, true, `expected ${url} to be allowed`);
				assert.equal(res.reason, undefined, `expected ${url} to not have a rejection reason`);
			}
		} finally {
			restore();
		}
	});

	it("rejects SVG body served with a spoofed image/png Content-Type", async () => {
		// sharp reports mediaType "image/svg+xml" for SVG. A server that sends an
		// SVG body with Content-Type: image/png must NOT let the sniff-override in
		// readImageFileWithReason relabel it to image/svg+xml and accept it as an
		// image in non-strict mode.
		const svg = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
			"utf8",
		);
		const restore = stubFetch(svg, { "content-type": "image/png" });
		try {
			const res = await readImageFileWithReason("http://93.184.216.34/evil.png");
			assert.equal(res.image, null);
		} finally {
			restore();
		}
	});

	it("honors VP_MAX_IMAGE_BYTES size limit", async () => {
		// A content-length above the limit makes downloadImageFromUrl return null.
		const png = Buffer.from(PNG_B64, "base64");
		const restore = stubFetch(png, {
			"content-type": "image/png",
			"content-length": String(10 * 1024 * 1024 + 1),
		});
		try {
			process.env.VP_MAX_IMAGE_BYTES = "500000";
			const res = await readImageFileWithReason("http://93.184.216.34/large.png");
			assert.equal(res.image, null);
			assert.equal(res.reason, "unreadable");
		} finally {
			delete process.env.VP_MAX_IMAGE_BYTES;
			restore();
		}
	});

	it("rejects an empty URL body with reason empty", async () => {
		const restore = stubFetch(new Uint8Array(0), { "content-type": "image/png" });
		try {
			const res = await readImageFileWithReason("http://93.184.216.34/empty.png");
			assert.equal(res.image, null);
			assert.equal(res.reason, "empty");
		} finally {
			restore();
		}
	});

	it("releases the redirect-hop socket and re-validates the next URL", async () => {
		// Each redirect hop must release its connection and the next hop must
		// pass SSRF validation before any fetch is issued for it.
		let fetchCalls = 0;
		const cancelled: boolean[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			fetchCalls++;
			if (fetchCalls === 1) {
				return {
					ok: true,
					status: 302,
					headers: {
						get: (k: string) =>
							k.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null,
					},
					body: {
						cancel: async () => {
							cancelled.push(true);
						},
					},
				} as unknown as Response;
			}
			throw new Error("must not fetch a restricted redirect target");
		}) as typeof fetch;
		try {
			const res = await readImageFileWithReason("http://93.184.216.34/redirect.png");
			assert.equal(res.image, null);
			// The block happens inside the download loop, so it maps to the
			// download-failure reason rather than the initial-host "denied".
			assert.equal(res.reason, "unreadable");
			assert.equal(cancelled.length, 1, "the redirect response body must be released");
			assert.equal(fetchCalls, 1, "the redirect target must be re-validated before fetching");
		} finally {
			globalThis.fetch = original;
		}
	});

	it("releases the socket when the server returns an error status", async () => {
		let cancelled = false;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			return {
				ok: false,
				status: 503,
				body: {
					cancel: async () => {
						cancelled = true;
					},
				},
				headers: { get: () => null },
			} as unknown as Response;
		}) as typeof fetch;
		try {
			const res = await readImageFileWithReason("http://93.184.216.34/fail.png");
			assert.equal(res.image, null);
			assert.equal(res.reason, "unreadable");
			assert.equal(cancelled, true, "the error response body must be released");
		} finally {
			globalThis.fetch = original;
		}
	});

	it("cancels the response body when content-length exceeds the size limit", async () => {
		// The socket-release invariant: a content-length rejection must cancel the
		// body just like redirect, error-status, and oversize-stream paths do.
		let cancelled = false;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			return {
				ok: true,
				status: 200,
				body: {
					cancel: async () => {
						cancelled = true;
					},
				},
				headers: {
					get: (k: string) => (k === "content-length" ? String(10 * 1024 * 1024 + 1) : null),
				},
			} as unknown as Response;
		}) as typeof fetch;
		try {
			process.env.VP_MAX_IMAGE_BYTES = "500000";
			const res = await readImageFileWithReason("http://93.184.216.34/huge.png");
			assert.equal(res.image, null);
			assert.equal(res.reason, "unreadable");
			assert.equal(cancelled, true, "body should be cancelled on content-length rejection");
		} finally {
			delete process.env.VP_MAX_IMAGE_BYTES;
			globalThis.fetch = original;
		}
	});
});

describe("analyzeImagesWithModel transient retry", () => {
	// Exercise the real retry loop inside analyzeImagesWithModel by injecting a
	// fake generateText that throws transient errors on the first attempt(s).
	// This validates the actual production retry path, not a copy of it.
	function flakyGenerateText(transientFailures: number, message: string) {
		let calls = 0;
		return {
			async call(_opts: unknown): Promise<{ text: string }> {
				calls++;
				if (calls <= transientFailures) {
					throw new Error(message);
				}
				return { text: `success on call ${calls}` };
			},
			calls() {
				return calls;
			},
		};
	}

	function req(impl: unknown): AnalyzeRequest {
		return {
			imagePayloads: [],
			systemPrompt: "sys",
			question: "q",
			model: {} as AnalyzeRequest["model"],
			generateTextImpl: impl as AnalyzeRequest["generateTextImpl"],
		};
	}

	it("retries on transient error (429 rate limit)", async () => {
		const gen = flakyGenerateText(1, "Rate limit 429 too many requests");
		const out = await analyzeImagesWithModel(req(gen.call));
		assert.equal(gen.calls(), 2);
		assert.ok(out.text.includes("success on call 2"));
	});

	it("retries on transient error (503 service unavailable)", async () => {
		const gen = flakyGenerateText(1, "503 service unavailable");
		const out = await analyzeImagesWithModel(req(gen.call));
		assert.equal(gen.calls(), 2);
		assert.ok(out.text.includes("success on call 2"));
	});

	it("does not retry on invalid argument (400 client error)", async () => {
		const gen = flakyGenerateText(1, "Request contains an invalid argument");
		await assert.rejects(
			() => analyzeImagesWithModel(req(gen.call)),
			(e) => e instanceof Error && /invalid argument/.test(e.message),
		);
		assert.equal(gen.calls(), 1);
	});

	it("does not retry on non-transient error", async () => {
		const gen = flakyGenerateText(99, "400 bad request - not transient");
		await assert.rejects(
			() => analyzeImagesWithModel(req(gen.call)),
			(e) => e instanceof Error && /400 bad request/.test(e.message),
		);
		assert.equal(gen.calls(), 1);
	});

	it("passes maxRetries: 0 so the SDK never compounds its own retries", async () => {
		// This function owns transient retries; if maxRetries leaked through as
		// the SDK default, one logical attempt would fan out into extra provider
		// calls on top of the local loop.
		const seen: Array<{ maxRetries?: number }> = [];
		await analyzeImagesWithModel(
			req((opts: unknown) => {
				seen.push(opts as { maxRetries?: number });
				return Promise.resolve({ text: "ok" });
			}),
		);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].maxRetries, 0);
	});

	it("throws after max retries exhausted", async () => {
		const gen = flakyGenerateText(99, "Rate limit 429 too many requests");
		await assert.rejects(
			() => analyzeImagesWithModel(req(gen.call)),
			(e) => e instanceof Error && /Rate limit 429/.test(e.message),
		);
		assert.equal(gen.calls(), 2); // 1 initial + 1 retry
	});
});
