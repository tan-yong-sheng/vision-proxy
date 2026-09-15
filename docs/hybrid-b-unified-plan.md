# Hybrid Option B — Unified Verified Implementation Plan (`--context`, last-8)
Branch: `feat/analyze-question-context` | Date: 2026-09-15 | Plan only, no code edits

## 1. Verified findings (claim vs local source + cited URL)

### 1a. Claude Code / Codex stdio hook — CONFIDENCE HIGH
- PreToolUse fields `hook_event_name, tool_name, tool_input, tool_use_id, session_id, transcript_path, cwd, permission_mode` — VERIFIED against `~/.claude/.../claude_agent_sdk/types.py` (exists, 82.6K, 26 hits for transcript_path/session_id) and Codex `pre-tool-use.command.input.schema.json` (keys + required list confirmed via JSON parse). Confidence 100%.
- UserPromptSubmit `prompt: string` — VERIFIED in both SDK types and Codex `user-prompt-submit...schema.json` (keys confirmed). Confidence 100%.
- Dual snake_case/camelCase fallback already handles Codex — VERIFIED `src/hook-script.ts:120-136` (`tool_input||toolInput`, `tool_name||toolName`, `session_id||sessionId`). No adapter change needed for names. Confidence 100%.
- `--question` exists, `--context` does NOT — VERIFIED: `src/command-runner.ts:645` (`question: str(flags,"question")??str(flags,"q")`), `VALUE_FLAGS` set has `question,q` but no `context`; `src/analysis/pipeline.ts:149` (`flags.question ?? ""`); `src/analysis/types.ts:20` (`question?: string`, no `context`); `src/adapter.ts:49` (`buildPromptText(images, question)`). Confidence 100%.
- `hookSpecificOutput.additionalContext + permissionDecision deny` shape — VERIFIED `src/hook-script.ts:165-175`. Matches Codex output schema claim. Confidence 100%.
- Transcript JSONL entry types `user/assistant/attachment/last-prompt/file-history-snapshot` — PLAUSIBLE, cited from local `~/.claude/projects/*.jsonl`; not re-verified here. Treat Codex transcript format inference as 60-70% (reports themselves admit instability; SDK warns format is "internal / pass-through blobs").

### 1b. Upstream last-8 constants — VERIFIED LOCALLY, contradiction in reports flagged
- Reports cite `upstream extensions/internal.ts:2243-2270` with `RECENT_MESSAGE_COUNT=8, ASSISTANT_TRUNCATE=500, CONTEXT_MAX=3000` as "not available locally". CONTRADICTION: the canonical port already lives in `src/core.ts:326-328` (`RECENT_MESSAGE_COUNT=8, ASSISTANT_TRUNCATE_CHARS=500, CONTEXT_MAX_CHARS=3000`) with `buildConversationContext()` at `src/core.ts:1450-1464` (filter user|assistant, slice(-8), `User:/Assistant:` lines, assistant truncate, `truncateContext` keeps last 3000 chars with leading `…`) and `buildToolCacheKey()` at `src/core.ts:1835-1842` (`?q=${questionHash}&m=`). Use THESE names verbatim; do not invent `ASSISTANT_TRUNCATE`/`CONTEXT_MAX` without `_CHARS` suffix. Confidence 100% on local source.
- `includeContext` is resolved by the CLI with a built-in default of `true`: `src/core.ts` supplies the default and `src/analysis/pipeline.ts` drops `--context` before provider dispatch when the resolved config is false. Generated hooks use the separate `VP_INCLUDE_CONTEXT` environment gate, also defaulting to true, because they must not synchronously read config files. Confidence 100% on the local implementation.

### 1c. Pi extension — MIXED (downgraded where cited file missing)
- Cited `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — NOT FOUND locally (`find` empty). All 100% claims pinned to that path are UNVERIFIED here; downgrade to 70% pending `npm view / install` verification.
- `ctx.sessionManager.getBranch()` existence — VERIFIED empirically: `~/.pi/agent/extensions/slim-ctxsession.ts:369-370` (`ctx.sessionManager.getBranch()`), matching report. `vision-proxy.ts` installed copy exists (`~/.pi/agent/extensions/vision-proxy.ts:16.3K`). Confidence 90% that `getBranch(): SessionEntry[]` is stable.
- Current Pi adapter shapes — VERIFIED `src/pi-extension.ts:193-266` (context handler duck-types `msg.role/content`, REMINDER_MARKER strip, never shells out; tool_result intercepts `read` via `event.input.path`, `runAnalyze([filePath], signal)` 2-arg only). Any `--context` wiring requires extending `runAnalyze` signature. Confidence 100%.
- `getMode()` VP_MODE-live + cached config, `ctx.signal` AbortSignal — VERIFIED `src/pi-extension.ts:151-179,131-145,260-263`. No change needed. Confidence 95%.

### 1d. opencode plugin — HIGH on hooks, MEDIUM on history API
- `chat.message` + `tool.execute.before` hooks — VERIFIED `/tmp/pkg-opencode/package/dist/index.d.ts:187,235` (grep hits). `sessionID/tool/callID/args` shapes as reported. Confidence 95%.
- `TuiState.session.messages()` vs `client.session.messages()` availability inside `PluginInput` — NOT re-verified here (SDK gen file exists at `/tmp/pkg-sdk/.../sdk.gen.d.ts:26.3K` but contents not parsed). Treat Option B/C latency claims (~100ms) as 60%. Ring-buffer recommendation (no network) is the safe default regardless. Confidence 60%.
- Current opencode adapter — VERIFIED `src/opencode-plugin.ts:147-225` (chat.message reminder-only + INJECTION_MARKER strip; tool.execute.before read→runAnalyze→throw-to-deny; `runAnalyze(images)` 1-arg, `buildAnalyzeArgs(images,maxTokens)` 2-arg). Confidence 100%.

## 2. Unified implementation plan — hybrid B (`--context` alongside `--question`)

Design intent (all four reports converge): vision model gets image + `--question` (current user intent) + `--context` (last-8 user|assistant slice). Shared parser lives once in `src/hooks/runtime.ts`; each host supplies messages from its native source. Everything fail-open, capped, standalone-safe (no backticks / no `${` in `HOOK_RUNTIME_SOURCE`-composed code — string concat only).

### Step 0 — Resolved decisions
- `includeContext` defaults to true. The CLI uses the layered config value; standalone hooks use `VP_INCLUDE_CONTEXT` with the same true default and do not read config files.
- Flag semantics: `--question` = single current intent; `--context` = last-8 history block. Keep both; never merge.
- Prompt-block format: mirror `buildPromptText`'s `<user_message>` escaping; add `<conversation_context>` block (see Step 3).

### Step 1 — Shared runtime `src/hooks/runtime.ts` (canonical, tested + shipped)
Add verbatim-named constants + one pure parser (concat-only, no imports beyond existing):
- `RECENT_MESSAGE_COUNT=8`, `ASSISTANT_TRUNCATE_CHARS=500`, `CONTEXT_MAX_CHARS=3000` (mirror `src/core.ts:326-328`).
- `buildConversationContext(messages: Array<{role,text}|{role,content}>)` — filter role user|assistant, slice(-8), `User: /Assistant:` lines, assistant slice(0,500), join `\n`, keep last 3000 chars with leading `…`. Accept both pre-extracted `{role,text}` and raw `{role,content}` (string or TextContent[]) so Pi (AgentMessage) and stdio (transcript JSONL) share it.
- Extend `buildAnalyzeArgs(images, maxTokens, question?, context?)` — append `--question <q>` then `--context <c>` only when non-empty (after `--max-output-tokens`).
- Add `VP_INCLUDE_CONTEXT` gate helper `includeContextEnabled(env)` defaulting per Step-0 decision; when off, callers skip context build entirely.
- Standalone constraint: new code must pass `standaloneViolations()` (no backtick, no `${`, no `vision-proxy` import) — covered by `src/hooks/generated-sources.test.ts`.

### Step 2 — CLI `src/command-runner.ts` + `src/analysis/types.ts` + `src/analysis/pipeline.ts` + `src/core.ts` cache
- `command-runner.ts`: add `"context"` to `VALUE_FLAGS`, `context: str(flags,"context")` into `AnalyzeFlags` (next to line 645 `question`), add `--context <text>` to HELP + `analyze` HELP_INDEX block.
- `analysis/types.ts`: add `context?: string` next to `question?: string`.
- `pipeline.ts`: `const context = flags.context ?? ""`; pass `context` into both `analyzeImpl()` calls (single line ~174, joint line ~219); extend the cache key with an injective tuple serialization such as `hashImageData(JSON.stringify([question, context]))` — never delimiter-concatenate the fields — so question-only entries cannot collide with question+context entries.
- `adapter.ts`: extend `AnalyzeRequest{context?}` + `buildPromptText(images, question, context?)` — prepend `<conversation_context>\n{escaped}\n</conversation_context>\n\n` when non-empty, mirroring existing `<user_message>` escaping.

### Step 3 — Per-host wiring (adapters only call shared runtime)
- **Claude/Codex `src/hook-script.ts`** (shared stdio adapter): UserPromptSubmit writes `event.prompt` → `~/.claude/image-cache/<sessionId>/vp-prompt.txt` (reuse `imageCacheDir()` + traversal guard at `:82`); PreToolUse reads it as `--question` (delete-after-read to avoid staleness), AND parses `event.transcript_path` JSONL tail (last-8 user|assistant via shared parser, caps enforced) as `--context`. Priority: side-channel question + transcript context; either missing → omit that flag (fail-open). Same file serves Codex (field fallback already handles snake_case).
- **Pi `src/pi-extension.ts`**: a bounded, session-keyed map keyed by `ctx.sessionManager.getSessionId()` stores the latest question and the last-8 user/assistant messages from the `context` event. The `tool_result` handler looks up that session record and passes context as the fourth `buildAnalyzeArgs` argument (`buildAnalyzeArgs(images, maxTokens, undefined, contextText)`). Missing/empty stash → omit `--context`.
- **opencode `src/opencode-plugin.ts`**: module `Map<sessionID, {role,text,id?}[]>` ring buffer (cap 8/session), with session-keyed question state and LRU refresh. `handleChatMessage` pushes the current user text after stripping `INJECTION_MARKER`; the context builder excludes that current question before `handleToolExecuteBefore` passes history to `runAnalyze([file], question, context)`. Use the fourth `buildAnalyzeArgs` parameter for context. Evict on bound map size. No SDK polling on hot path.

### Step 4 — Tests (golden + standalone + unit)
- `src/hooks/runtime.test.ts`: parser cases (string vs TextContent[], assistant truncation at 500, total cap 3000 with `…`, non-user|assistant filtered, empty→`""`), `buildAnalyzeArgs` flag emission (neither/either/both), gate on/off.
- `src/hooks/hook-script.test.ts`: side-channel write/read/delete, traversal-guard rejects (`../`, `/`, `\`), transcript-tail parse + fail-open (missing file, bad JSON, empty → null).
- `src/hooks/generated-sources.test.ts` (+ Pi/opencode golden tests): regenerate artifacts contain `--context`, no standalone violations.
- `src/command-runner.test.ts` / `src/cli.test.ts`: `--context` parsing, help text, `AnalyzeFlags` plumbing; `src/core.test.ts` or pipeline test: cache-key changes with context.
- Commands: `npm test -- src/hooks/runtime.test.ts`, `npm test -- src/hooks/hook-script.test.ts`, `npm test -- src/hooks/generated-sources.test.ts`, then `npm test` (full). Lint/build per repo (`npm run lint` / `tsc --noEmit` if configured).

### Step 5 — Fail-open, timeout, privacy (must-haves per host)
- Fail-open: every context build wrapped in try/catch → stderr log → null → proceed without `--context`; `vp analyze` non-zero/empty → existing null path; hook `emit` unchanged.
- Timeout: transcript tail-read bounded (read last ~64KB / last 200 lines max, <5ms typical) within existing `DEFAULT_HOOK_TIMEOUT_MS=30000`; Pi abort via `ctx.signal`; opencode `execFile` timeout unchanged.
- Privacy: `--question` = current prompt only; `--context` = last-8 truncated (≤3000 chars) — document that both leave the machine to the vision provider; `VP_INCLUDE_CONTEXT=false` disables context (question still sent unless also gated — decide in Step 0); prompt cache file is session-scoped under existing `image-cache/<sessionId>/`, deleted after read.

## 3. Open risks
1. Transcript format stability (Claude + Codex): internal/unstable by SDK warning; resume/fork may point at wrong path — mitigated by side-channel primary + fail-open, parser tolerant to string|array content.
2. Resume/fork staleness: prompt file may be missing or stale (multi-prompt before Read) — latest-wins overwrite + delete-after-read; stale context degrades answer, never blocks.
3. Race (PreToolUse before UserPromptSubmit write; Pi context re-fire; opencode re-delivery): all handled by fail-open + idempotency markers (REMINDER_MARKER/INJECTION_MARKER strip).
4. Token/privacy cost: 8 messages ≤3000 chars still may include secrets/code sent to third-party vision model — gate via `VP_INCLUDE_CONTEXT`, document in CONFIG.md + README privacy note, default per Step-0.
5. Pi types unverified + opencode history-API latency unverified — confirm before implementation (see §1c/1d); ring-buffer + getBranch-fallback avoids both.
6. Cache-key collision if context added without key bump — Step 2 makes key change mandatory.
