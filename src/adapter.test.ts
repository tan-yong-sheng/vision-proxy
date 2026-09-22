import assert from "node:assert";
import { describe, it } from "node:test";
import { APICallError } from "ai";
import { type AnalyzeRequest, analyzeImagesWithModel, wrapAnalyzeError } from "./adapter.ts";

describe("analyzeImagesWithModel context block", () => {
	function payloadReq(
		impl: (opts: unknown) => Promise<{ text: string }>,
		extra: Partial<AnalyzeRequest> = {},
	): AnalyzeRequest {
		return {
			imagePayloads: [],
			systemPrompt: "sys",
			question: "what is this?",
			model: {} as AnalyzeRequest["model"],
			generateTextImpl: impl as AnalyzeRequest["generateTextImpl"],
			...extra,
		};
	}

	it("omits the conversation block without context", async () => {
		let seen = "";
		await analyzeImagesWithModel(
			payloadReq((opts: unknown) => {
				const messages = (opts as { messages: Array<{ content: unknown }> }).messages;
				seen = JSON.stringify(messages?.[0]?.content ?? "");
				return Promise.resolve({ text: "ok" });
			}),
		);
		assert.ok(!seen.includes("conversation_context"));
		assert.ok(seen.includes("what is this?"));
	});

	it("omits the user_message block without a question", async () => {
		let seen = "";
		await analyzeImagesWithModel(
			payloadReq(
				(opts: unknown) => {
					const messages = (opts as { messages: Array<{ content: unknown }> }).messages;
					const content = messages?.[0]?.content as Array<{ text?: string }>;
					seen = content?.[0]?.text ?? "";
					return Promise.resolve({ text: "ok" });
				},
				{ question: "" },
			),
		);
		assert.ok(!seen.includes("user_message"), "empty question must omit the block");
		assert.ok(!seen.includes("following message"), "empty question must omit the preamble");
		assert.match(seen, /Describe the image.*in detail/);
		assert.match(
			seen,
			/same language as the conversation context/,
			"no-question branch keeps a neutral language directive",
		);
	});

	it("omits the user_message block for a whitespace-only question", async () => {
		let seen = "";
		await analyzeImagesWithModel(
			payloadReq(
				(opts: unknown) => {
					const messages = (opts as { messages: Array<{ content: unknown }> }).messages;
					const content = messages?.[0]?.content as Array<{ text?: string }>;
					seen = content?.[0]?.text ?? "";
					return Promise.resolve({ text: "ok" });
				},
				{ question: "  \n\t" },
			),
		);
		assert.ok(!seen.includes("user_message"));
	});

	it("prepends an escaped conversation block with context", async () => {
		let seen = "";
		await analyzeImagesWithModel(
			payloadReq(
				(opts: unknown) => {
					const messages = (opts as { messages: Array<{ content: unknown }> }).messages;
					const content = messages?.[0]?.content as Array<{ text?: string }>;
					seen = content?.[0]?.text ?? "";
					return Promise.resolve({ text: "ok" });
				},
				{ context: "User: <plan> surprise" },
			),
		);
		assert.match(seen, /<conversation_context>/);
		assert.ok(seen.includes("&lt;plan&gt;"), "context must be escaped like the question");
		assert.ok(seen.indexOf("<conversation_context>") < seen.indexOf("<user_message>"));
	});

	it("escapes ampersands before sentinel tags", async () => {
		let seen = "";
		await analyzeImagesWithModel(
			payloadReq(
				(opts: unknown) => {
					const messages = (opts as { messages: Array<{ content: unknown }> }).messages;
					const content = messages?.[0]?.content as Array<{ text?: string }>;
					seen = content?.[0]?.text ?? "";
					return Promise.resolve({ text: "ok" });
				},
				{ question: "use &lt;/user_message&gt;" },
			),
		);
		assert.ok(seen.includes("&amp;lt;/user_message&amp;gt;"));
	});
});

describe("wrapAnalyzeError", () => {
	it("returns a clearer message for a 404 API call", () => {
		const err = new APICallError({
			message: "Not Found",
			url: "http://localhost:8317/models/gemini-3.5-flash-lite:generateContent",
			requestBodyValues: {},
			statusCode: 404,
		});
		const wrapped = wrapAnalyzeError(err) as Error;
		assert.match(
			wrapped.message,
			/Model endpoint returned 404 \(model not found\).*localhost:8317/,
		);
	});

	it("includes status code and URL for other API errors", () => {
		const err = new APICallError({
			message: "Bad Request",
			url: "http://localhost:8317/models/test:generateContent",
			requestBodyValues: {},
			statusCode: 400,
		});
		const wrapped = wrapAnalyzeError(err) as Error;
		assert.match(wrapped.message, /Model endpoint returned 400.*Bad Request/);
	});

	it("passes through non-API errors unchanged", () => {
		const err = new Error("something else");
		assert.strictEqual(wrapAnalyzeError(err), err);
	});
});
