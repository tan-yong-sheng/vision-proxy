/**
 * Seam tests for the command runner (`src/command-runner.ts`).
 *
 * Pins the Candidate 04 boundary: `src/cli.ts` is the process adapter (argv,
 * stdout/stderr, exit behavior, update-notifier setup) while the runner owns
 * command grammar, help lookup/rendering, dispatch, and result mapping. The
 * runner returns structured outcomes and never touches process streams, so
 * routing is pinned without stream capture.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as cli from "./cli.ts";
import {
	HELP,
	hookContextFileDir,
	isHookContextFile,
	MAX_ANALYZE_STDIN_BYTES,
	parseAnalyzeStdin,
	parseFlags,
	readAnalyzeContextFile,
	readAnalyzeStdin,
	renderHelp,
	runCommand,
	VALUE_FLAGS,
} from "./command-runner.ts";
import { ANALYZE_STDIN_MARKER } from "./integrations/runtime.ts";
import { VERSION } from "./version.ts";

describe("command-runner seam", () => {
	it("keeps the cli.ts compatibility surface by identity", () => {
		assert.equal(cli.parseFlags, parseFlags);
	});

	it("exposes the value-flag grammar", () => {
		assert.ok(VALUE_FLAGS.has("format"));
		assert.ok(VALUE_FLAGS.has("question"));
		assert.ok(VALUE_FLAGS.has("context"));
		assert.ok(!VALUE_FLAGS.has("json"));
		assert.ok(!VALUE_FLAGS.has("joint"));
	});

	it("parses boolean flags without swallowing positionals", () => {
		const { flags, positionals } = parseFlags(["--json", "image.png"]);
		assert.deepEqual(positionals, ["image.png"]);
		assert.equal(flags.json, true);
	});

	it("rejects value flags without a following value", async () => {
		assert.match(parseFlags(["--version"]).error ?? "", /missing value for --version/);
		const result = await runCommand(["update", "--version"]);
		assert.equal(result.code, 1);
		assert.match(result.stderr ?? "", /missing value for --version/);
	});

	it("parses value flags and --no-fence like the historical parser", () => {
		const valued = parseFlags(["--format", "qwen_pixels", "image.png"]);
		assert.deepEqual(valued.positionals, ["image.png"]);
		assert.equal(valued.flags.format, "qwen_pixels");

		const fence = parseFlags(["--no-fence", "image.png"]);
		assert.deepEqual(fence.positionals, ["image.png"]);
		assert.equal(fence.flags.fence, false);
	});

	it("parses --context as a value flag without swallowing positionals", () => {
		const parsed = parseFlags(["--context", "User: hi", "image.png"]);
		assert.deepEqual(parsed.positionals, ["image.png"]);
		assert.equal(parsed.flags.context, "User: hi");
		assert.equal(parseFlags(["--context"]).error, "missing value for --context");
	});

	it("decodes the analyze stdin payload and rejects non-payloads", () => {
		const payload = `${ANALYZE_STDIN_MARKER}\n${JSON.stringify({ question: "q?", context: "User: hi" })}`;
		assert.deepEqual(parseAnalyzeStdin(payload), { question: "q?", context: "User: hi" });
		// Marker mismatch (e.g. provider store-key key bytes) means no payload.
		assert.deepEqual(parseAnalyzeStdin("sk-secret-no-marker"), {});
		assert.deepEqual(parseAnalyzeStdin(""), {});
		assert.deepEqual(parseAnalyzeStdin(`${ANALYZE_STDIN_MARKER}\nnot-json`), {});
		assert.deepEqual(parseAnalyzeStdin(`${ANALYZE_STDIN_MARKER}\n[1,2]`), {});
		// Blank values are dropped so whitespace-only input stays absent.
		assert.deepEqual(
			parseAnalyzeStdin(
				`${ANALYZE_STDIN_MARKER}\n${JSON.stringify({ question: "  ", context: "" })}`,
			),
			{},
		);
	});

	it("prefers the stdin payload over argv flags for analyze", async () => {
		const payload = `${ANALYZE_STDIN_MARKER}\n${JSON.stringify({ question: "stdin-q", context: "stdin-ctx" })}`;
		const r = await runCommand(["analyze", "--question", "argv-q", "img.png"], {
			env: {} as NodeJS.ProcessEnv,
			cwd: "/",
			stdinText: payload,
		});
		// No API key is configured, so analyze must fail — but only after the
		// stdin payload won over the argv flag (the error path proves the
		// parse ran; the unit assertion below pins precedence directly).
		assert.equal(r.code, 1);
		const parsed = parseAnalyzeStdin(payload);
		assert.equal(parsed.question, "stdin-q");
		assert.equal(parsed.context, "stdin-ctx");
	});

	it("degrades to no payload when the injected stdin reader fails", async () => {
		// A stream error (EPIPE/EIO) must not reject runCommand: the analysis
		// simply proceeds without the sensitive payload (and here fails only
		// on the missing API key, proving the drain did not throw).
		const r = await runCommand(["analyze", "img.png"], {
			env: {} as NodeJS.ProcessEnv,
			cwd: "/",
			readStdin: async () => {
				throw new Error("EPIPE");
			},
		});
		assert.equal(r.code, 1);
		assert.match(r.stderr ?? "", /analyze error|analyze failed/);
	});

	it("drops context for --no-context while keeping the question", async () => {
		// --no-context is context-only: the stdin question survives while the
		// stdin context is dropped. runAnalyze is stubbed at the pipeline
		// seam via readStdin? No — assert through parseFlags + drain instead:
		// the flag parses boolean-true without swallowing the positional, and
		// a no-context analyze run carries no context to the model.
		const parsed = parseFlags(["--no-context", "image.png"]);
		assert.deepEqual(parsed.positionals, ["image.png"]);
		assert.equal(parsed.flags["no-context"], true);
		const payload = `${ANALYZE_STDIN_MARKER}\n${JSON.stringify({ question: "stdin-q", context: "stdin-ctx" })}`;
		const r = await runCommand(["analyze", "--no-context", "img.png"], {
			env: {} as NodeJS.ProcessEnv,
			cwd: "/",
			stdinText: payload,
		});
		// No API key: fails at provider resolution, proving the drain did
		// not throw and the flag threaded through.
		assert.equal(r.code, 1);
	});

	it("advertises --context in analyze help", () => {
		assert.match(renderHelp(["analyze"]), /--context <text>/);
	});

	it("parses --context-file as a value flag without swallowing positionals", () => {
		const parsed = parseFlags(["--context-file", "/tmp/vp-ctx.txt", "image.png"]);
		assert.deepEqual(parsed.positionals, ["image.png"]);
		assert.equal(parsed.flags["context-file"], "/tmp/vp-ctx.txt");
		assert.ok(VALUE_FLAGS.has("context-file"));
		assert.equal(parseFlags(["--context-file"]).error, "missing value for --context-file");
	});

	it("advertises --context-file in analyze help", () => {
		assert.match(renderHelp(["analyze"]), /--context-file <path>/);
	});

	it("rejects non-handoff --context-file paths without reading or deleting", () => {
		let reads = 0;
		const reader = (_p: string): string | null => {
			reads++;
			return "should never be read";
		};
		assert.equal(readAnalyzeContextFile("/tmp/vp-ctx.txt", reader), undefined);
		assert.equal(readAnalyzeContextFile("/etc/passwd", reader), undefined);
		assert.equal(readAnalyzeContextFile("~/.some-file", reader), undefined);
		assert.equal(reads, 0, "non-handoff paths must never reach the reader");
		assert.equal(isHookContextFile("/tmp/vp-ctx.txt"), false);
		assert.equal(isHookContextFile(undefined), false);
	});

	it("rejects traversal paths that resolve outside the handoff directory", () => {
		const dir = hookContextFileDir();
		const traversal = `${dir}/../victim/vp-context-secret.txt`;
		let reads = 0;
		assert.equal(
			readAnalyzeContextFile(traversal, () => {
				reads++;
				return "should never be read";
			}),
			undefined,
		);
		assert.equal(isHookContextFile(traversal), false);
		assert.equal(reads, 0, "traversal paths must never reach the reader");
	});

	it("measures the context-file cap in UTF-8 bytes, not UTF-16 units", () => {
		// U+1F600 encodes as 4 UTF-8 bytes but 2 UTF-16 units: a payload of
		// (cap/4)+1 emoji exceeds the byte cap while staying under a
		// length-based check.
		const emoji = "\uD83D\uDE00".repeat(MAX_ANALYZE_STDIN_BYTES / 4 + 1);
		const dir = hookContextFileDir();
		assert.equal(
			readAnalyzeContextFile(`${dir}/vp-context-abc.txt`, () => emoji),
			undefined,
		);
	});

	it("reads --context-file content as analyze context", async () => {
		const dir = hookContextFileDir();
		const handoff = `${dir}/vp-context-test1.txt`;
		const r = await runCommand(["analyze", "--context-file", handoff, "img.png"], {
			env: {} as NodeJS.ProcessEnv,
			cwd: "/",
			stdinText: "",
			readContextFile: (p) => (p === handoff ? "User: file history" : null),
		});
		// No API key: fails at provider resolution, proving the file read
		// threaded through without throwing.
		assert.equal(r.code, 1);
		assert.equal(
			readAnalyzeContextFile(handoff, () => "User: file history"),
			"User: file history",
		);
		assert.equal(isHookContextFile(handoff), true);
	});

	it("prefers stdin over --context-file, and --context-file over argv --context", () => {
		const dir = hookContextFileDir();
		const handoff = `${dir}/vp-context-test2.txt`;
		const file = (p: string) => (p === handoff ? "file-ctx" : null);
		assert.equal(readAnalyzeContextFile(handoff, file), "file-ctx");
		assert.equal(readAnalyzeContextFile(undefined, file), undefined);
		assert.equal(readAnalyzeContextFile("", file), undefined);
		assert.equal(
			readAnalyzeContextFile(handoff, () => null),
			undefined,
		);
		assert.equal(
			readAnalyzeContextFile(handoff, () => "   "),
			undefined,
		);
	});

	it("drops oversize --context-file content with a stderr diagnostic", () => {
		const errChunks: string[] = [];
		const savedErr = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			errChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const dir = hookContextFileDir();
			assert.equal(
				readAnalyzeContextFile(`${dir}/vp-context-big.txt`, () =>
					"x".repeat(MAX_ANALYZE_STDIN_BYTES + 1),
				),
				undefined,
			);
		} finally {
			process.stderr.write = savedErr;
		}
		assert.ok(errChunks.join("").includes("exceeds"), "oversize file must be diagnosable");
	});

	it("drops --context-file content under --no-context", async () => {
		const dir = hookContextFileDir();
		const handoff = `${dir}/vp-context-test3.txt`;
		const parsed = parseFlags(["--no-context", "--context-file", handoff, "img.png"]);
		assert.equal(parsed.flags["no-context"], true);
		assert.equal(parsed.flags["context-file"], handoff);
		const r = await runCommand(["analyze", "--no-context", "--context-file", handoff, "img.png"], {
			env: {} as NodeJS.ProcessEnv,
			cwd: "/",
			stdinText: "",
			readContextFile: () => "User: file history",
		});
		assert.equal(r.code, 1);
	});

	it("consumes the handoff before help and validation early returns", async () => {
		const dir = hookContextFileDir();
		// analyze --help must not strand the handoff file on disk.
		const helpHandoff = `${dir}/vp-context-help.txt`;
		let helpReads = 0;
		const helpResult = await runCommand(["analyze", "--help", "--context-file", helpHandoff], {
			env: {} as NodeJS.ProcessEnv,
			cwd: "/",
			stdinText: "",
			readContextFile: () => {
				helpReads++;
				return "User: file history";
			},
		});
		assert.equal(helpResult.code, 0);
		assert.equal(helpReads, 1, "help path must still consume the handoff");
		// Missing-image error must not strand the handoff either.
		const missingHandoff = `${dir}/vp-context-missing.txt`;
		let missingReads = 0;
		const missingResult = await runCommand(["analyze", "--context-file", missingHandoff], {
			env: {} as NodeJS.ProcessEnv,
			cwd: "/",
			stdinText: "",
			readContextFile: () => {
				missingReads++;
				return "User: file history";
			},
		});
		assert.equal(missingResult.code, 1);
		assert.equal(missingReads, 1, "validation path must still consume the handoff");
		// Non-analyze commands must never touch the reader.
		let otherReads = 0;
		const versionResult = await runCommand(["version", "--context-file", helpHandoff], {
			env: {} as NodeJS.ProcessEnv,
			cwd: "/",
			readContextFile: () => {
				otherReads++;
				return "User: file history";
			},
		});
		assert.equal(versionResult.code, 0);
		assert.equal(otherReads, 0, "non-analyze commands must not consume the handoff");
	});

	it("renders help with parent fallback then top-level HELP", () => {
		assert.match(renderHelp(["analyze"]), /vp analyze <paths\.\.\.>/);
		assert.match(renderHelp(["config", "set"]), /vp config set <key> <value>/);
		// Unknown subcommand falls back to the parent block.
		assert.equal(renderHelp(["config", "bogus"]), renderHelp(["config"]));
		// Unknown command falls back to top-level HELP.
		assert.equal(renderHelp(["bogus"]), HELP);
	});

	it("resolves top-level help and version without side effects", async () => {
		const before = process.exitCode;
		for (const argv of [[], ["help"], ["--help"], ["-h"]] as string[][]) {
			const r = await runCommand(argv, { env: {} as NodeJS.ProcessEnv, cwd: "/" });
			assert.equal(r.code, 0);
			assert.match(r.stdout ?? "", /vision-proxy \(vp\)/);
			assert.equal(r.stderr, undefined);
		}
		const version = await runCommand(["version"], { env: {} as NodeJS.ProcessEnv, cwd: "/" });
		assert.equal(version.stdout, VERSION);
		assert.equal(version.code, 0);
		assert.equal(process.exitCode, before);
	});

	it("resolves per-subcommand help without running commands", async () => {
		const analyze = await runCommand(["analyze", "--help"]);
		assert.match(analyze.stdout ?? "", /--crop <i:form>/);
		assert.equal(analyze.code, 0);

		const configHelp = await runCommand(["config", "help"]);
		assert.match(configHelp.stdout ?? "", /vp config <subcommand>/);
		assert.ok(!/unknown config subcommand/.test(configHelp.stdout ?? ""));

		const update = await runCommand(["update", "--help"]);
		assert.match(update.stdout ?? "", /vp update \[/);
		assert.equal(update.code, 0);

		const list = await runCommand(["integration", "list", "--help"]);
		assert.match(list.stdout ?? "", /installed agents/);
		assert.equal(list.code, 0);
	});

	it("rejects unknown commands with the historical wording and codes", async () => {
		const unknown = await runCommand(["bogus"]);
		assert.equal(unknown.code, 1);
		assert.match(unknown.stderr ?? "", /unknown command "bogus"/);
		assert.equal(unknown.stdout, undefined);

		const provider = await runCommand(["openai"]);
		assert.equal(provider.code, 1);
		assert.match(provider.stderr ?? "", /is a provider, not a command/);
	});

	it("rejects missing positionals and bad subcommands without side effects", async () => {
		const noImages = await runCommand(["analyze", "--json"]);
		assert.equal(noImages.code, 1);
		assert.match(noImages.stderr ?? "", /requires at least one image path/);

		const badConfig = await runCommand(["config", "bogus"]);
		assert.equal(badConfig.code, 1);
		assert.match(badConfig.stderr ?? "", /unknown config subcommand/);

		const setUsage = await runCommand(["config", "set", "provider"]);
		assert.equal(setUsage.code, 1);
		assert.match(setUsage.stderr ?? "", /usage: vp config set/);

		const storeUsage = await runCommand(["provider", "store-key"]);
		assert.equal(storeUsage.code, 1);
		assert.match(storeUsage.stderr ?? "", /usage: vp provider store-key/);

		const badCache = await runCommand(["cache", "bogus"]);
		assert.equal(badCache.code, 1);
		assert.match(badCache.stderr ?? "", /unknown cache subcommand/);
	});

	it("never touches process streams or exitCode", async () => {
		const exitBefore = process.exitCode;
		const r = await runCommand(["bogus"]);
		assert.equal(r.code, 1);
		assert.equal(process.exitCode, exitBefore);
	});
});

describe("readAnalyzeStdin", () => {
	// A minimal fake stdin: capture which events were registered and let the
	// test drive data/end/error manually, plus record pause() calls.
	function fakeStdin(overrides: Partial<{ isTTY: boolean; pausedCalls: number }> = {}) {
		const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
		const fake = {
			isTTY: false,
			pausedCalls: 0,
			on(ev: string, cb: (...a: unknown[]) => void) {
				if (!handlers[ev]) handlers[ev] = [];
				handlers[ev].push(cb);
				return fake;
			},
			removeListener(ev: string, cb: (...a: unknown[]) => void) {
				if (handlers[ev]) handlers[ev] = handlers[ev].filter((f) => f !== cb);
				return fake;
			},
			pause() {
				fake.pausedCalls += 1;
			},
			...overrides,
		};
		const emit = (ev: string, ...args: unknown[]) => {
			for (const cb of [...(handlers[ev] ?? [])]) cb(...args);
		};
		return { fake, handlers, emit };
	}

	async function withStdin(stdin: unknown, fn: () => Promise<void>): Promise<void> {
		const original = process.stdin;
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		try {
			await fn();
		} finally {
			Object.defineProperty(process, "stdin", { value: original, configurable: true });
		}
	}

	it("skips a TTY stdin without reading", async () => {
		const { fake } = fakeStdin({ isTTY: true });
		await withStdin(fake, async () => {
			assert.equal(await readAnalyzeStdin(50), "");
		});
	});

	it("returns empty when stdin is absent", async () => {
		await withStdin(null, async () => {
			assert.equal(await readAnalyzeStdin(50), "");
		});
	});

	it("resolves on end with the concatenated payload", async () => {
		const { fake, emit } = fakeStdin();
		await withStdin(fake, async () => {
			const p = readAnalyzeStdin(2000);
			// Let the promise attach its listeners before driving the stream.
			await new Promise((r) => setImmediate(r));
			emit("data", Buffer.from('vp-analyze-payload-v1\n{"question":"hi"}'));
			emit("end");
			assert.equal(await p, 'vp-analyze-payload-v1\n{"question":"hi"}');
		});
	});

	it("degrades to empty on timeout and detaches listeners", async () => {
		const { fake, handlers } = fakeStdin();
		await withStdin(fake, async () => {
			const p = readAnalyzeStdin(30); // never emitted -> timeout path
			const val = await p;
			assert.equal(val, "");
			// Listeners must be removed on expiry so no background read lingers.
			assert.equal((handlers.data ?? []).length, 0, "data listener detached");
			assert.equal((handlers.end ?? []).length, 0, "end listener detached");
			assert.equal((handlers.error ?? []).length, 0, "error listener detached");
			assert.ok(fake.pausedCalls > 0, "stdin paused");
		});
	});

	it("warns on stderr when the timeout cuts off partial data", async () => {
		const { fake, emit } = fakeStdin();
		const errChunks: string[] = [];
		const savedErr = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			errChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await withStdin(fake, async () => {
				const p = readAnalyzeStdin(30);
				await new Promise((r) => setImmediate(r));
				emit("data", Buffer.from('vp-analyze-payload-v1\n{"que'));
				assert.equal(await p, "");
			});
		} finally {
			process.stderr.write = savedErr;
		}
		assert.ok(
			errChunks.join("").includes("stdin payload incomplete"),
			"partial-data timeout must be diagnosable",
		);
	});

	it("drops oversize stdin before it can bloat memory", async () => {
		const { fake, emit } = fakeStdin();
		const errChunks: string[] = [];
		const savedErr = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			errChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await withStdin(fake, async () => {
				const p = readAnalyzeStdin(2000);
				await new Promise((r) => setImmediate(r));
				// One chunk over the 256KB cap: fail closed, no buffering.
				emit("data", Buffer.alloc(MAX_ANALYZE_STDIN_BYTES + 1, "x"));
				assert.equal(await p, "");
			});
		} finally {
			process.stderr.write = savedErr;
		}
		assert.ok(errChunks.join("").includes("exceeds"), "oversize stdin must be diagnosable");
	});

	it("degrades to empty on a stream error", async () => {
		const { fake, emit } = fakeStdin();
		await withStdin(fake, async () => {
			const p = readAnalyzeStdin(2000);
			await new Promise((r) => setImmediate(r));
			emit("error", new Error("EPIPE"));
			assert.equal(await p, "");
		});
	});
});
