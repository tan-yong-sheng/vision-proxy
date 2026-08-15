/**
 * Unit tests for the version module: reading the running version from
 * package.json and embedding/extracting the version marker in artifacts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION, renderVersionMarker, extractMarkerVersion } from "./version.ts";

test("VERSION is a non-empty semver-ish string", () => {
	assert.equal(typeof VERSION, "string");
	assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test("renderVersionMarker embeds the running version", () => {
	assert.equal(renderVersionMarker(), `__VP_VERSION__:${VERSION}`);
});

test("extractMarkerVersion round-trips through renderVersionMarker", () => {
	assert.equal(extractMarkerVersion(renderVersionMarker()), VERSION);
});

test("extractMarkerVersion reads a marker embedded in surrounding text", () => {
	const src = `// header\n// __VP_VERSION__:0.4.2\nimport x from "y";`;
	assert.equal(extractMarkerVersion(src), "0.4.2");
});

test("extractMarkerVersion returns undefined when no marker present", () => {
	assert.equal(extractMarkerVersion("no marker here"), undefined);
});
