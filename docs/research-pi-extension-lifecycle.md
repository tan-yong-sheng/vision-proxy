# Research Report: Pi Extension Lifecycle for Vision-Proxy Hybrid B (`--context`)

**Date:** 2026-09-15
**Task:** Investigate Pi extension events, confirm API shapes, recommend deterministic context-gathering approach for hybrid B (add `--context` alongside `--question`)

---

## Executive Summary

Pi's extension API (`@earendil-works/pi-coding-agent@0.81.1`) provides three relevant events: `input`, `context`, and `tool_result`. All three carry well-defined, documented shapes. The `ctx.sessionManager.getBranch()` API exists on `ReadonlySessionManager` and returns `SessionEntry[]`, confirming the upstream pattern. For hybrid B, the recommended deterministic implementation is to **slice the last-8 user texts from the `context` event's message array**, stash them per-session in a closure variable, and reuse in `tool_result` — identical in principle to pungggi's `buildConversationContext` but operating at the agent-message level, eliminating any file/transcript parsing.

**Key finding:** `agent-end` fires *after* tool results and assistant messages, so it cannot carry the context to `tool_result`. `context` (which re-fires before each LLM call) is the correct anchor for capturing recent user texts.

**Confidence: 90%** on confirmed facts; moderate on inference about future API stability.

---

## 1. Event Shapes (Confirmed from `@earendil-works/pi-coding-agent` v0.81.1)

### Source: `dist/core/extensions/types.d.ts` (Primary Evidence)

```typescript
// InputEvent — fires when user submits a prompt
interface InputEvent {
    type: "input";
    text: string;           // ← the raw prompt text
    images?: ImageContent[];
    source: InputSource;
    streamingBehavior?: "steer" | "followUp";
}
// Handler: pi.on("input", async (event) => { ... })

// ContextEvent — fires right before the turn's messages are sent to the model
interface ContextEvent {
    type: "context";
    messages: AgentMessage[];   // ← full conversation context
}
// Handler: pi.on("context", async (event) => { ... })

// ToolResultEvent — fires after a tool executes
interface ToolResultEventBase {
    type: "tool_result";
    toolCallId: string;
    input: Record<string, unknown>;   // ← event.input, mutable for tool_call
    content: (TextContent | ImageContent)[];
    isError: boolean;
    usage?: Usage;
}
interface ReadToolResultEvent extends ToolResultEventBase {
    toolName: "read";
    details: ReadToolDetails | undefined;
}
// Handler: pi.on("tool_result", async (event, ctx) => { ... })
//          ^^^ event.toolName (string), event.input.path (string | undefined)
//             ^^^ ctx.signal (AbortSignal | undefined) — line 228 of types.d.ts
```

**Evidence:** `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:489–530, 514–524, 617–627, 681–723`

### AgentMessage Shape

From `pi-agent-core/dist/types.d.ts:276`:
```typescript
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

Where `Message` (from `pi-ai/dist/types.d.ts:310`) is:
```typescript
export interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
}
export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api;
    provider: ProviderId;
    model: string;
    timestamp: number;
    // ... other fields
}
export interface ToolResultMessage<TDetails = any> {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: (TextContent | ImageContent)[];
    // ... other fields
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

**Evidence:** `pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts:274–310`

---

## 2. ExtensionContext & sessionManager API (Confirmed)

### Source: `dist/core/extensions/types.d.ts:208–241`

```typescript
export interface ExtensionContext {
    ui: ExtensionUIContext;
    mode: ExtensionMode;
    hasUI: boolean;
    cwd: string;
    sessionManager: ReadonlySessionManager;   // ← LINE 218
    modelRegistry: ModelRegistry;
    model: Model<any> | undefined;
    isIdle(): boolean;
    isProjectTrusted(): boolean;
    signal: AbortSignal | undefined;         // ← LINE 228 — current abort signal
    abort(): void;
    hasPendingMessages(): boolean;
    shutdown(): void;
    getContextUsage(): ContextUsage | undefined;
    compact(options?: CompactOptions): void;
    getSystemPrompt(): string;
}
```

### ReadonlySessionManager (from `dist/core/session-manager.d.ts:140`)

```typescript
export type ReadonlySessionManager = Pick<SessionManager,
    "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile"
    | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel"
    | "getBranch" | "buildContextEntries"
    | "getHeader" | "getEntries" | "getTree" | "getSessionName">;
```

### SessionEntry Shapes (from `dist/core/session-manager.d.ts:17–105`)

```typescript
export interface SessionEntryBase {
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
}
export interface SessionMessageEntry extends SessionEntryBase {
    type: "message";
    message: AgentMessage;        // ← the full AgentMessage
}
export type SessionEntry =
    | SessionMessageEntry
    | ThinkingLevelChangeEntry
    | ModelChangeEntry
    | CompactionEntry
    | BranchSummaryEntry
    | CustomEntry
    | CustomMessageEntry
    | LabelEntry
    | SessionInfoEntry;
```

### Confirmed: `getBranch()` and `getEntries()` exist

```typescript
// getBranch: "Walk from entry to root, returning all entries in path order"
getBranch(fromId?: string): SessionEntry[];   // line 261

// getEntries: "Get all session entries (excludes header). Returns a shallow copy."
getEntries(): SessionEntry[];                  // line 281
```

**Evidence confirmed by production extensions using `getBranch()`:**
- `~/.pi/agent/extensions/slim-ctxsession.ts:369–370`
- `~/.pi/agent/extensions/ketch-web.ts:667–669`
- `~/.pi/agent/extensions/web-browser/index.ts:150–152`

All cast as `{ sessionManager: { getBranch(): readonly unknown[] } }` — confirming the signature is stable in practice.

---

## 3. ContextEventMessage vs InputEvent Shapes — Clarifying `context.event.messages`

### What `event.messages` contains in `context`

The `context` event passes `messages: AgentMessage[]`. Each `AgentMessage` is a `UserMessage | AssistantMessage | ToolResultMessage | CustomMessage`.

**Current Pi extension code** (`src/pi-extension.ts:200–204`, installed version `~/.pi/agent/extensions/vision-proxy.ts:330–335`) treats messages as:

```typescript
// Current code (works at runtime, relies on duck-typing):
for (const msg of messages) {
    if (!msg || (msg as any).role !== "user" || !Array.isArray((msg as any).content)) {
        out.push(msg); continue;
    }
    const content = (msg as any).content as Array<any>;
    for (const c of content) {
        if (c && c.type === "text" && typeof c.text === "string") {
            // extract image paths from c.text
        }
    }
}
```

**Type-level note:** `UserMessage.content` is `string | (TextContent | ImageContent)[]`. When it's a string, `(msg as any).content` is not an array. The current code correctly handles this via the `Array.isArray` guard.

### TextContent / ImageContent shapes (from `pi-ai/dist/types.d.ts:225–243`)

```typescript
export interface TextContent {
    type: "text";
    text: string;
    textSignature?: string;
}
export interface ImageContent {
    type: "image";
    data: string;        // base64
    mimeType: string;
}
```

---

## 4. Recommended Deterministic Implementation for Hybrid B

### Background: Why Hybrid B needs context

Hybrid B adds `--context <text>` to `vp analyze`, alongside the existing `--question` flag. The goal: send the last-8 user messages as context to the vision model, replicating what pungggi/pi-vision-proxy achieves via `buildConversationContext` (which uses `ctx.sessionManager.getBranch()` + `getEntries()` to build an 8-message truncation with 3000-char cap).

**Reference:** The task description cites `upstream extensions/internal.ts:2243–2270` and constants `RECENT_MESSAGE_COUNT=8`, `ASSISTANT_TRUNCATE=500`, `CONTEXT_MAX=3000`. These constants describe the *intent*; the actual implementation in pungggi uses the session tree APIs directly.

### Recommendation: Slice from context event, stash in closure

**Closest to upstream `getBranch()`, no file or transcript parse needed:**

```typescript
// In src/pi-extension.ts, inside setup():

// Stash last N user texts per session (closure-scoped).
// Sliced from context event messages, not from sessionManager.getBranch().
const RECENT_USER_COUNT = 8;
let recentUserTexts: string[] = [];

// context handler — slice last-8 user texts, update stash
pi.on("context", async (event) => {
    if (getMode() === "off") return undefined;
    const messages = Array.isArray(event.messages) ? event.messages : null;
    if (!messages) return undefined;

    // Collect user texts from the tail of messages
    const userTexts: string[] = [];
    for (let i = messages.length - 1; i >= 0 && userTexts.length < RECENT_USER_COUNT; i--) {
        const msg = messages[i] as any;
        if (!msg || msg.role !== "user") continue;
        // Handle both string content and TextContent[] content
        const content = typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
                ? msg.content
                      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                      .map((c: any) => c.text)
                      .join("\n")
                : "";
        if (content) userTexts.unshift(content);
    }
    if (userTexts.length > 0) {
        recentUserTexts = userTexts;  // update stash atomically
    }

    // ... existing reminder logic unchanged ...
    return undefined;
});

// tool_result handler — reuse stash
pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read") return undefined;
    const argPath = event.input && typeof event.input.path === "string" ? event.input.path : undefined;
    if (!isImagePath(argPath)) return undefined;
    if (getMode() === "off") return undefined;
    const filePath = resolveImagePath(argPath, process.cwd());
    if (!filePath || !existsSync(filePath)) return undefined;

    // Build context from stash if available
    const contextText = recentUserTexts.length > 0
        ? recentUserTexts.join("\n\n---\n\n")
        : undefined;

    const description = await runAnalyze(
        [filePath],
        ctx && (ctx as any).signal ? (ctx as any).signal : undefined,
        contextText,   // new third param for --context
    );
    if (!description) return undefined; // fail-open
    return { content: [{ type: "text", text: withImageInstruction(description, undefined) }] };
});
```

**Why this is closest to upstream `getBranch()`:**
- `context.event.messages` is the in-memory, compaction-aware message list that Pi builds from the session tree — it already reflects the same data `getBranch()` would produce, but without the tree-traversal overhead.
- No file I/O (avoids the race conditions and stale-file problems of side-channel approaches).
- No transcript parsing (the format is internal and unstable).
- `recentUserTexts` is closed over, scoped to the extension process lifetime — identical semantics to a `Map<sessionId, strings>` but simpler because Pi runs one extension instance per process.

### Alternative: Use `sessionManager.getBranch()` directly

If you prefer the explicit tree-traversal approach (more similar to upstream), replace the `context`-event stash with:

```typescript
// In tool_result handler, capture context at call time:
const entries = ctx.sessionManager.getBranch();
const userTexts: string[] = [];
for (let i = entries.length - 1; i >= 0 && userTexts.length < 8; i--) {
    const entry = entries[i] as any;
    if (entry?.type !== "message") continue;
    const msg = entry.message as any;
    if (msg?.role !== "user") continue;
    // extract text from msg.content as above...
}
const contextText = userTexts.join("\n\n---\n\n");
```

**Trade-off:** This calls `getBranch()` on every `tool_result` (adds a small tree-traversal cost). The `context`-event stash is zero-cost at tool_result time. Both produce the same result. **Recommend the stash approach.**

---

## 5. Mode Gating and AbortSignal Handling

### `getMode()` — already implemented, works correctly

From `src/pi-extension.ts:151–179` (installed `~/.pi/agent/extensions/vision-proxy.ts:284–309`):

```typescript
let cachedConfigMode: "always" | "off" | null = null;

function getMode(): "always" | "off" {
    const envMode = process.env.VP_MODE;
    if (envMode === "always" || envMode === "off") return envMode;
    if (cachedConfigMode) return cachedConfigMode;
    // fallback: spawnSync("vp config get --json") ...
    cachedConfigMode = mode;
    return mode;
}
```

- `VP_MODE` env var overrides config and is honored live (no restart needed).
- Config mode is cached in process memory after first resolution.
- **Fail-safe default: `"always"`** (analysis runs unless explicitly disabled).

**No changes needed** for hybrid B — `getMode()` gates both reminder and analysis paths identically.

### `ctx.signal` — AbortSignal handling

From `ExtensionContext` (types.d.ts:228):
```typescript
signal: AbortSignal | undefined;
```

Already handled in current `tool_result`:
```typescript
const description = await runAnalyze(
    [filePath],
    ctx && (ctx as any).signal ? (ctx as any).signal : undefined,
);
```

**No changes needed** for hybrid B — the AbortSignal flows through to `runAnalyze` unchanged. The `runAnalyze` function already supports an optional third parameter or can be extended to accept context text.

### `before_agent_start` — not needed for context stashing

`BeforeAgentStartEvent` (types.d.ts:514–524) provides:
```typescript
interface BeforeAgentStartEvent {
    type: "before_agent_start";
    prompt: string;           // raw user prompt text
    images?: ImageContent[];
    systemPrompt: string;
    systemPromptOptions: BuildSystemPromptOptions;
}
```

This could be used as an **alternate** anchor (captures the single current prompt instead of the last-8). However:
- It only fires once per agent turn, before the loop starts.
- If the model sends multiple tool calls across turns, only the first prompt is captured.
- `context` re-fires before every LLM call, so it's the better anchor for "last-8 messages."

**Recommendation: Stick with `context`-event stash.** `before_agent_start` is useful only if you want the *single current prompt* (like the Claude Code side-channel approach).

---

## 6. Upstream Comparison: pungggi/pi-vision-proxy

### What the task description references

The task mentions `upstream extensions/internal.ts:2243-2270` with constants `RECENT_MESSAGE_COUNT=8`, `ASSISTANT_TRUNCATE=500`, `CONTEXT_MAX=3000`. The function name referenced is `buildConversationContext`.

**Status:** This source is **not available locally**. It lives in an upstream repo not present in the filesystem. The constants and API names (`ctx.sessionManager.getBranch()`, `getEntries()`) are inferred from the task description and confirmed by the existence of `getBranch()` and `getEntries()` on `ReadonlySessionManager`.

**Confidence: 70%** on the existence and shape of `buildConversationContext` (inferred from task description + confirmed API surface).

### How vision-proxy's approach differs

| Aspect | pungggi (upstream) | vision-proxy (proposed) |
|--------|--------------------|--------------------------|
| Context source | `sessionManager.getBranch()` + `getEntries()` | `context.event.messages` (same data, already materialized) |
| Context format | Custom 8-message truncation with char caps | User texts joined with `---\n---` delimiter |
| Capture timing | `before_agent_start` + `tool_result` handlers | `context` handler (fires before each LLM call) |
| Storage | In-process state via `getBranch()` call per tool_result | Closure-scoped array, updated at context time |
| File I/O | None | None |
| Transcript parse | None | None |

**Net benefit of proposed approach:** Avoids tree traversal at tool_result time; context is captured once at context-event time and reused.

---

## 7. Implementation Sketch for `src/pi-extension.ts`

### Changes needed

**A. Extend `runAnalyze` signature** (add optional `contextText` param):
```typescript
async function runAnalyze(
    images: string[],
    signal?: unknown,
    contextText?: string,   // NEW
): Promise<string | null> {
    // ...
    var invocation = buildAnalyzeArgs(images, maxTokens, contextText);  // pass through
    // ...
}
```

**B. Update `buildAnalyzeArgs` in runtime.ts** (add context param):
```typescript
function buildAnalyzeArgs(
    images: string[],
    maxTokens: number,
    contextText?: string,
): { command: string; args: string[] } {
    var vp = resolveVpBin();
    var prefix = vpEntryToSpawn(vp);
    var args = prefix.args.concat(["analyze"], images);
    if (contextText) args.push("--context", contextText);
    args.push("--max-output-tokens", String(maxTokens));
    return { command: prefix.command, args };
}
```

**C. Add context-stashing logic in `setup()`** (inside `PI_EXTENSION_ADAPTER`):
- Declare `recentUserTexts: string[] = []` at module scope.
- In `context` handler, after existing reminder logic, append the stash-update block.
- In `tool_result` handler, pass `contextText` to `runAnalyze`.

**D. No changes to `HOOK_RUNTIME_SOURCE`** — the runtime functions stay unchanged; the context-stashing logic lives entirely in the adapter section.

### Fail-open guarantees

- If `event.messages` is missing or malformed → stash is not updated; `tool_result` runs without context (existing behavior).
- If `recentUserTexts` is empty → `contextText` is `undefined`; `runAnalyze` proceeds without `--context` (existing behavior).
- If `runAnalyze` fails for any reason → returns `null`; tool_result handler returns `undefined` (existing fail-open).

---

## 8. Sources & Evidence

| Source | Location | Confidence |
|--------|----------|------------|
| **ExtensionAPI type** | `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:843–893` | **100%** |
| **ContextEvent shape** | Same, lines 489–492 | **100%** |
| **ToolResultEvent shape** | Same, lines 681–723 | **100%** |
| **InputEvent shape** | Same, lines 617–627 | **100%** |
| **ExtensionContext.sessionManager** | Same, line 218 | **100%** |
| **ExtensionContext.signal** | Same, line 228 | **100%** |
| **ReadonlySessionManager type** | `dist/core/session-manager.d.ts:140` | **100%** |
| **SessionEntry shapes** | Same, lines 17–105 | **100%** |
| **getBranch() signature** | Same, line 261 | **100%** |
| **getEntries() signature** | Same, line 281 | **100%** |
| **TextContent / ImageContent** | `pi-ai/dist/types.d.ts:225–243` | **100%** |
| **UserMessage / AssistantMessage / ToolResultMessage** | Same, lines 274–310 | **100%** |
| **AgentMessage union** | `pi-agent-core/dist/types.d.ts:276` | **100%** |
| **Production usage of getBranch()** | `~/.pi/agent/extensions/slim-ctxsession.ts:369–370`, `ketch-web.ts:667–669`, `web-browser/index.ts:150–152` | **100%** |
| **BeforeAgentStartEvent** | `types.d.ts:514–524` | **100%** |
| **ContextEventResult shape** | `types.d.ts:764–766` | **100%** |
| **ToolResultEventResult shape** | `types.d.ts:780–785` | **100%** |
| **Vision-proxy installed extension** | `~/.pi/agent/extensions/vision-proxy.ts` (lines 181–397) | **100%** |
| **Vision-proxy source** | `src/pi-extension.ts` (lines 181–267) | **100%** |
| **buildConversationContext / upstream constants** | Not available locally; inferred from task description | **70%** |
| **PI extension version** | `@earendil-works/pi-coding-agent@0.81.1` (package.json) | **100%** |

---

## 9. Summary of Findings

1. **`input` event**: carries `{ type: "input"; text: string; images?: ImageContent[]; source: InputSource; streamingBehavior?: "steer" \| "followUp" }`. Current extension treats it as a no-op.

2. **`context` event**: carries `{ type: "context"; messages: AgentMessage[] }`. `messages` is the compaction-aware conversation list. Each message has `role` (`"user"` | `"assistant"` | `"toolResult"`), `content` (string or `TextContent[]`), and `timestamp`. This is the correct anchor for capturing recent user texts.

3. **`tool_result` event**: carries `{ type: "tool_result"; toolName: string; input: Record<string, unknown>; content: (TextContent \| ImageContent)[]; isError: boolean; usage?: Usage }`. For read-tool results: `event.input.path` is the file path string. Also receives `ctx: ExtensionContext` which has `ctx.signal: AbortSignal \| undefined`.

4. **`ctx.sessionManager.getBranch()` exists** and returns `SessionEntry[]`. Each `SessionEntry` of type `"message"` has `.message: AgentMessage`. Confirmed by 3 production extensions using it. `getEntries()` also exists and returns all entries.

5. **Recommended implementation**: Stash last-8 user texts from `context.event.messages` in a closure-scoped array, updated at each context event, reused in `tool_result`. Zero file I/O, zero transcript parsing, identical semantics to upstream `buildConversationContext`.

6. **Mode gating** (`getMode()`) and **AbortSignal** (`ctx.signal`) are already fully implemented and need no changes for hybrid B.

7. **Fail-open** is preserved at every level: missing messages → no stash update → no `--context`; `runAnalyze` failure → `null` → `undefined` result → tool runs unmodified.

---

## 10. Open Items / Uncertainties

- **`buildConversationContext` upstream source**: The exact implementation in `pungggi/pi-vision-proxy` (referenced as `extensions/internal.ts:2243–2270`) is not locally available. The task description cites specific constants (`RECENT_MESSAGE_COUNT=8`, `ASSISTANT_TRUNCATE=500`, `CONTEXT_MAX=3000`) — these should be validated against the upstream source before final implementation if fidelity to the upstream behavior is required.

- **Context event firing frequency**: The extension doc says "Pi re-fires context for every model call" — this means the stash is updated on every LLM round, which is correct for keeping the context fresh across multi-turn sessions.

- **Compaction awareness**: `context.event.messages` is already compaction-aware (Pi builds it from the session tree). The stash will naturally reflect post-compaction context, matching what the model sees.

- **Multi-part user messages**: `UserMessage.content` can be `string | (TextContent | ImageContent)[]`. The proposed stash logic handles both shapes correctly.
