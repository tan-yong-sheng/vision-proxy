import assert from "node:assert";
import { describe, it } from "node:test";
import { APICallError } from "ai";
import { wrapAnalyzeError } from "./adapter.ts";

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
