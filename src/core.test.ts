/**
 * Unit tests for vision-proxy core pure helpers.
 *
 * Run:
 *   node --experimental-strip-types --no-warnings --test src/core.test.ts
 *
 * Requires Node 22+ for native TypeScript stripping. No build / no deps.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	buildDescriptionFence,
	buildJointDescriptionFence,
	buildToolCacheKey,
	clampPixels,
	DEFAULT_CONFIG,
	escapeAttr,
	fenceUntrusted,
	getGroundingFormat,
	hashImageData,
	isRestrictedAddress,
	isValidNamedRegion,
	LRUCache,
	normalizedToPixels,
	parseCropArg,
	parseModelString,
	resolveConfig,
	resolveCropEntry,
	resolveRegion,
} from "./core.ts";

describe("hashImageData", () => {
	it("returns a 32-char hex prefix of sha256", () => {
		const h = hashImageData("hello");
		assert.equal(h.length, 32);
		assert.match(h, /^[0-9a-f]{32}$/);
	});

	it("matches the known sha256 prefix for a known input", () => {
		// sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
		assert.equal(hashImageData("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e");
	});

	it("is stable across calls", () => {
		assert.equal(hashImageData("abc"), hashImageData("abc"));
	});

	it("differs for different inputs", () => {
		assert.notEqual(hashImageData("a"), hashImageData("b"));
	});
});

describe("escapeAttr", () => {
	it("escapes quotes, ampersands, and angle brackets", () => {
		assert.equal(escapeAttr('a"b<c>&d'), "a&quot;b&lt;c&gt;&amp;d");
	});

	it("replaces null bytes with the replacement character", () => {
		// U+FFFD replacement character.
		const input = `a${String.fromCharCode(0)}b`;
		assert.equal(escapeAttr(input), "a�b");
	});
});

describe("fenceUntrusted", () => {
	it("neutralizes nested vision_proxy tags by breaking the angle brackets", () => {
		const ZW = String.fromCharCode(0x200b);
		const out = fenceUntrusted("<vision_proxy_description>evil</vision_proxy_description>");
		assert.ok(!out.includes("<vision_proxy_description>"));
		assert.ok(out.includes(`<${ZW}vision_proxy_description>`));
		assert.ok(out.includes(`<${ZW}/vision_proxy_description>`));
	});
});

describe("normalizedToPixels", () => {
	it("scales a normalized rect to pixels", () => {
		const r = normalizedToPixels({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, 100, 50);
		assert.deepEqual(r, { x: 10, y: 10, width: 50, height: 20 });
	});

	it("returns null for a zero-area crop", () => {
		const r = normalizedToPixels({ x: 0, y: 0, width: 0, height: 0.5 }, 100, 50);
		assert.equal(r, null);
	});
});

describe("clampPixels", () => {
	it("clamps an out-of-bounds pixel rect", () => {
		const r = clampPixels({ x: -5, y: -5, width: 200, height: 200 }, 100, 50);
		assert.deepEqual(r, { x: 0, y: 0, width: 100, height: 50 });
	});
});

describe("resolveRegion / isValidNamedRegion", () => {
	it("returns the normalized rect for a known region", () => {
		assert.deepEqual(resolveRegion("center"), { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
		assert.equal(isValidNamedRegion("top-left"), true);
		assert.equal(isValidNamedRegion("nope"), false);
	});
});

describe("parseCropArg", () => {
	it("parses a named region crop", () => {
		assert.deepEqual(parseCropArg("0:r=center"), { image_index: 0, region: "center" });
	});

	it("parses a normalized crop", () => {
		assert.deepEqual(parseCropArg("1:n=0.1,0.2,0.5,0.4"), {
			image_index: 1,
			normalized: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
		});
	});

	it("parses a pixel crop", () => {
		assert.deepEqual(parseCropArg("0:p=10,20,30,40"), {
			image_index: 0,
			pixels: { x: 10, y: 20, width: 30, height: 40 },
		});
	});
});

describe("resolveCropEntry", () => {
	it("resolves a region crop at given image dimensions", () => {
		const c = resolveCropEntry({ image_index: 0, region: "top-left" }, 100, 100);
		assert.deepEqual(c, { x: 0, y: 0, width: 50, height: 50 });
	});

	it("throws on invalid image dimensions", () => {
		assert.throws(() => resolveCropEntry({ image_index: 0, region: "center" }, 0, 0));
	});
});

describe("parseModelString", () => {
	it("splits provider/model", () => {
		assert.deepEqual(parseModelString("openai/gpt-4o"), { provider: "openai", modelId: "gpt-4o" });
	});

	it("returns null for malformed input", () => {
		assert.equal(parseModelString("no-slash"), null);
		assert.equal(parseModelString("/only-model"), null);
		assert.equal(parseModelString("provider/"), null);
	});
});

describe("getGroundingFormat", () => {
	it("returns the configured format for a known model", () => {
		assert.equal(
			getGroundingFormat(DEFAULT_CONFIG, "Qwen", "Qwen2.5-VL-7B-Instruct"),
			"qwen_pixels",
		);
	});

	it("returns none when not configured", () => {
		assert.equal(getGroundingFormat(DEFAULT_CONFIG, "anthropic", "claude-sonnet-4-5"), "none");
	});
});

describe("buildToolCacheKey", () => {
	it("folds hashes, crop signature, question hash, and model", () => {
		const key = buildToolCacheKey(["h1", "h2"], "0,0,10,10", "qhash", "openai/gpt-4o");
		assert.equal(key, "h1+h2#crop:0,0,10,10?q=qhash&m=openai/gpt-4o");
	});

	it("omits crop signature when absent", () => {
		const key = buildToolCacheKey(["h1"], undefined, "qhash", "openai/gpt-4o");
		assert.equal(key, "h1?q=qhash&m=openai/gpt-4o");
	});
});

describe("LRUCache", () => {
	it("evicts least-recently-used entries beyond maxSize", () => {
		const c = new LRUCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		c.get("a"); // touch a so b is LRU
		c.set("c", 3); // evicts b
		assert.equal(c.get("a"), 1);
		assert.equal(c.get("b"), undefined);
		assert.equal(c.get("c"), 3);
	});

	it("supports entries() and delete()", () => {
		const c = new LRUCache<string, number>(3);
		c.set("x", 9);
		assert.equal(c.delete("x"), true);
		assert.equal(c.delete("x"), false);
		assert.deepEqual(c.entries(), []);
	});
});

describe("resolveConfig", () => {
	it("applies env overrides on top of defaults", () => {
		const cfg = resolveConfig({ VP_MODEL: "openai/gpt-4o" } as NodeJS.ProcessEnv);
		assert.equal(cfg.provider, "openai");
		assert.equal(cfg.modelId, "gpt-4o");
	});

	it("falls back to defaults for invalid env values", () => {
		const cfg = resolveConfig({ VP_MAX_IMAGES_PER_CALL: "not-a-number" } as NodeJS.ProcessEnv);
		assert.equal(cfg.maxImagesPerCall, DEFAULT_CONFIG.maxImagesPerCall);
	});

	it("exposes cacheMaxAgeDays default of 30", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv);
		assert.equal(cfg.cacheMaxAgeDays, 30);
	});

	it("applies VP_CACHE_MAX_AGE_DAYS env override", () => {
		const cfg = resolveConfig({ VP_CACHE_MAX_AGE_DAYS: "7" } as NodeJS.ProcessEnv);
		assert.equal(cfg.cacheMaxAgeDays, 7);
	});

	it("falls back to default for out-of-range VP_CACHE_MAX_AGE_DAYS", () => {
		const cfg = resolveConfig({ VP_CACHE_MAX_AGE_DAYS: "99999" } as NodeJS.ProcessEnv);
		assert.equal(cfg.cacheMaxAgeDays, DEFAULT_CONFIG.cacheMaxAgeDays);
	});

	it("defaults maxImagesPerCall to 4", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv);
		assert.equal(cfg.maxImagesPerCall, 4);
	});

	it("applies the deprecated maxBatch alias when maxImagesPerCall is unset", () => {
		const cfg = resolveConfig({ VP_MAX_BATCH: "2" } as NodeJS.ProcessEnv, { maxBatch: 2 });
		assert.equal(cfg.maxImagesPerCall, 2);
	});

	it("reads maxBatch from a config file as an alias", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv, { maxBatch: 2 });
		assert.equal(cfg.maxImagesPerCall, 2);
	});

	it("prefers maxImagesPerCall over the maxBatch alias", () => {
		const cfg = resolveConfig({
			VP_MAX_IMAGES_PER_CALL: "5",
			VP_MAX_BATCH: "2",
		} as NodeJS.ProcessEnv);
		assert.equal(cfg.maxImagesPerCall, 5);
	});

	it("leaves the canonical default when only the alias is absent", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv);
		assert.equal(cfg.maxImagesPerCall, DEFAULT_CONFIG.maxImagesPerCall);
	});

	it("applies apiKey from file config", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv, { apiKey: "file-key" });
		assert.equal(cfg.apiKey, "file-key");
	});

	it("defaults apiKey to empty string", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv);
		assert.equal(cfg.apiKey, "");
	});
});

describe("resolveConfig baseUrl", () => {
	it("defaults to empty baseUrl", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv);
		assert.equal(cfg.baseUrl, "");
	});

	it("applies VP_BASE_URL env override", () => {
		const cfg = resolveConfig({
			VP_BASE_URL: "http://localhost:8000/v1",
		} as NodeJS.ProcessEnv);
		assert.equal(cfg.baseUrl, "http://localhost:8000/v1");
	});

	it("ignores empty VP_BASE_URL", () => {
		const cfg = resolveConfig({
			VP_BASE_URL: "",
		} as NodeJS.ProcessEnv);
		assert.equal(cfg.baseUrl, "");
	});
});

describe("sanitize baseUrl", () => {
	it("defaults to empty string for non-string baseUrl", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv, {
			baseUrl: 123,
		});
		assert.equal(cfg.baseUrl, "");
	});

	it("keeps valid string baseUrl", () => {
		const cfg = resolveConfig({} as NodeJS.ProcessEnv, {
			baseUrl: "https://custom.example",
		});
		assert.equal(cfg.baseUrl, "https://custom.example");
	});
});

describe("fence builders", () => {
	it("buildDescriptionFence wraps the description and neutralizes nested tags", () => {
		const f = buildDescriptionFence(
			"hash123",
			"<vision_proxy_description>x</vision_proxy_description>",
		);
		assert.ok(f.startsWith('<vision_proxy_description image="hash123"'));
		assert.ok(!f.includes("<vision_proxy_description>x"));
	});

	it("buildJointDescriptionFence lists all images", () => {
		const f = buildJointDescriptionFence([{ hash: "h1" }, { hash: "h2" }], "desc");
		assert.ok(f.includes('images="2"'));
		assert.ok(f.startsWith("<vision_proxy_joint_description"));
	});
});

describe("isRestrictedAddress", () => {
	it("blocks IPv4-mapped IPv6 in both hex and dotted (RFC-5952) forms", () => {
		// URL literals canonicalize to hex; DNS results arrive dotted.
		const blocked = [
			"::ffff:7f00:1", // hex form of ::ffff:127.0.0.1
			"::ffff:127.0.0.1", // dotted form as returned by dns.lookup
			"::ffff:169.254.169.254",
			"::ffff:10.0.0.5",
			"::ffff:192.168.1.1",
		];
		for (const ip of blocked) {
			assert.equal(isRestrictedAddress(ip), true, `expected ${ip} to be restricted`);
		}
	});

	it("allows public IPv4-mapped addresses", () => {
		assert.equal(isRestrictedAddress("::ffff:8.8.8.8"), false);
		assert.equal(isRestrictedAddress("::ffff:1.2.3.4"), false);
	});

	it("blocks the deprecated IPv4-compatible ::/96 form in hex and dotted tails", () => {
		const blocked = [
			"::7f00:1", // hex form of ::127.0.0.1, as URL canonicalization emits
			"::127.0.0.1", // dotted form
			"::a9fe:a9fe", // ::169.254.169.254 metadata service
			"::a00:1", // ::10.0.0.1 private range
		];
		for (const ip of blocked) {
			assert.equal(isRestrictedAddress(ip), true, `expected ${ip} to be restricted`);
		}
		assert.equal(isRestrictedAddress("::801:808"), false); // ::8.1.8.8 public
	});

	it("covers the full link-local fe80::/10 and site-local fec0::/10 ranges", () => {
		const blocked = ["fe80::1", "febf::1", "fec0::1", "feff::1"];
		for (const ip of blocked) {
			assert.equal(isRestrictedAddress(ip), true, `expected ${ip} to be restricted`);
		}
		assert.equal(isRestrictedAddress("fe7f::1"), false); // below fe80::/10
		assert.equal(isRestrictedAddress("ff00::1"), false); // multicast, outside /10
	});

	it("matches loopback exactly without over-blocking ::-prefixed globals", () => {
		assert.equal(isRestrictedAddress("::1"), true);
		assert.equal(isRestrictedAddress("0:0:0:0:0:0:0:1"), true); // full form
		assert.equal(isRestrictedAddress("[::1]"), true); // bracketed literal
		assert.equal(isRestrictedAddress("::10"), false);
		assert.equal(isRestrictedAddress("::1:1"), false);
	});

	it("blocks restricted IPv4 embedded in the NAT64 well-known prefix 64:ff9b::/96", () => {
		const blocked = [
			"64:ff9b::a9fe:a9fe", // hex form of 64:ff9b::169.254.169.254 metadata service
			"64:ff9b::169.254.169.254", // dotted form
			"64:ff9b::7f00:1", // hex form of 64:ff9b::127.0.0.1 loopback
			"64:ff9b::10.0.0.5", // private range
		];
		for (const ip of blocked) {
			assert.equal(isRestrictedAddress(ip), true, `expected ${ip} to be restricted`);
		}
		// Public embedded IPv4 stays allowed: NAT64 translation of public hosts
		// is the prefix's legitimate purpose.
		assert.equal(isRestrictedAddress("64:ff9b::8.8.8.8"), false);
		assert.equal(isRestrictedAddress("64:ff9b::1.2.3.4"), false);
	});
});
