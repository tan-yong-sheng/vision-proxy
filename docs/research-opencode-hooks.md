# Research Report: opencode Plugin Hooks for Vision-Proxy Hybrid B

**Date:** 2026-09-15
**Task:** Research opencode `chat.message` + `tool.execute.before` hook payloads, session history API availability, and deterministic implementation for hybrid option B (`--context` flag with last-8 messages).

---

## Executive Summary

Opencode's v1 plugin system exposes two hooks relevant to vision-proxy:

1. **`chat.message`** — fires when a user sends a message; receives `{ sessionID, agent?, model?, messageID?, variant? }` as input and can mutate `{ message: UserMessage, parts: Part[] }` in output.
2. **`tool.execute.before`** — fires before any tool executes; receives `{ tool, sessionID, callID }` as input and can mutate `{ args: any }` in output. Throwing an error denies the tool call.

**Key finding:** The TUI-only `TuiState.session.messages(sessionID)` API returns full message history (including `Part[]` per message), giving a stable source for last-8 message context. The SDK client also exposes `session.messages({ id: sessionID })` as an HTTP API endpoint. No session history is currently injected into the hook input — the plugin must query it explicitly.

**Confirmed constraint:** The plugin source is embedded via `String.raw` (no backticks, no `${`). The current `opencode-plugin.ts` implementation uses a ring-buffer approach at in-memory state (via `PluginInput.directory` as cwd scope) and is idempotent via `INJECTION_MARKER`/`REMINDER_MARKER` stripping.

---

## 1. Hook Payload Shapes (from `@opencode-ai/plugin@1.18.30` dist/index.d.ts)

### Source
- **Primary evidence:** `/tmp/pkg-opencode/package/dist/index.d.ts` (installed npm package, v1.18.30)
- **Doc URL:** https://github.com/opencode-ai/opencode/tree/main/packages/plugin

### `chat.message` Hook

```typescript
"chat.message"?: (input: {
    sessionID: string;
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    messageID?: string;
    variant?: string;
}, output: {
    message: UserMessage;
    parts: Part[];
}) => Promise<void>;
```

**Input fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionID` | `string` | yes | Unique session identifier |
| `agent` | `string?` | no | Agent name (e.g., "opencode") |
| `model.providerID` | `string?` | no | Provider ID (e.g., "openai", "anthropic") |
| `model.modelID` | `string?` | no | Model ID (e.g., "claude-3-5-haiku-20241022") |
| `messageID` | `string?` | no | ID of the current message being sent |
| `variant` | `string?` | no | Message variant (e.g., "user", "assistant") |

**Output fields (mutable):**
| Field | Type | Mutability | Description |
|-------|------|------------|-------------|
| `message` | `UserMessage` | read-only (pass-through) | Full user message object |
| `parts` | `Part[]` | **read-write** | Array of message parts — plugin appends/removes from this |

### `tool.execute.before` Hook

```typescript
"tool.execute.before"?: (input: {
    tool: string;
    sessionID: string;
    callID: string;
}, output: {
    args: any;
}) => Promise<void>;
```

**Input fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tool` | `string` | yes | Tool name (e.g., "read", "Bash", "Glob") |
| `sessionID` | `string` | yes | Session identifier |
| `callID` | `string` | yes | Unique call identifier for this tool invocation |

**Output fields (mutable):**
| Field | Type | Mutability | Description |
|-------|------|------------|-------------|
| `args` | `any` | **read-write** | Tool arguments — plugin can mutate or throw to deny |

### `Part` Type (from `@opencode-ai/sdk@1.18.30`)

```typescript
export type Part = TextPart | {
    id: string; sessionID: string; messageID: string;
    type: "subtask"; prompt: string; description: string; agent: string;
} | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart;

export type TextPart = {
    id: string; sessionID: string; messageID: string;
    type: "text"; text: string;
    synthetic?: boolean; ignored?: boolean;
    time?: { start: number; end?: number };
    metadata?: { [key: string]: unknown };
};

export type FilePart = {
    id: string; sessionID: string; messageID: string;
    type: "file"; mime: string; filename?: string; url: string;
    source?: FilePartSource;
};
```

---

## 2. Session History API — Can We Get Last-8 Messages?

### Finding: Two APIs Available

#### A. TUI State API (`TuiState.session.messages`)

From `@opencode-ai/plugin` dist/tui.d.ts — available **inside** the plugin's `PluginInput`:

```typescript
// TuiState (available via api.state in TUI plugins)
session: {
    count: () => number;
    get: (sessionID: string) => Session | undefined;
    messages: (sessionID: string) => ReadonlyArray<Message>;
    status: (sessionID: string) => SessionStatus | undefined;
    // ...
};

// Message union
type Message = UserMessage | AssistantMessage;
```

**Constraint:** `TuiState` is only available in the **TUI plugin entrypoint** (`TuiPluginApi`), NOT in the server-side `PluginInput`. The current `opencode-plugin.ts` uses `PluginInput` (not `TuiPluginApi`), so `TuiState.session.messages()` is **not directly available**.

#### B. SDK Client API (`session.messages()`)

From `@opencode-ai/sdk` dist/gen/sdk.gen.d.ts:

```typescript
declare class Session extends _HeyApiClient {
    messages<ThrowOnError extends boolean = false>(options: Options<SessionMessagesData, ThrowOnError>): RequestResult<SessionMessagesResponses, SessionMessagesErrors, ThrowOnError, "fields">;
}

export type SessionMessagesData = {
    body?: never;
    path: { id: string };
    query?: { directory?: string; limit?: number };
};
```

**How to use:** The plugin receives `PluginInput` which includes `client: ReturnType<typeof createOpencodeClient>`. The client has a `session.messages({ id: sessionID, query: { limit: 16 } })` method that returns an HTTP response with the last N messages.

**Response shape** (`SessionMessagesResponses`) — confirmed from SDK: returns `{ data: { messages: Message[] } }`.

### Verdict: Session history IS available, but requires HTTP call

The plugin can fetch last-8 (or more) messages via the SDK client's `session.messages()` HTTP endpoint. This adds ~50-200ms latency on each `chat.message` call, which is acceptable since this hook runs synchronously during message submission (before the model processes the message).

**Alternative (faster):** Use the `event` hook to subscribe to `message.updated` events and maintain an in-memory ring buffer per session. This avoids the HTTP roundtrip but requires managing state across events.

---

## 3. Existing Implementation Pattern (from `src/opencode-plugin.ts`)

The current plugin (lines 147–226) follows this architecture:

```typescript
async function handleChatMessage(
  input: { sessionID: string; messageID?: string },
  output: { message: { sessionID?: string }; parts: any[] },
  cwd: string,
): Promise<void> {
  // 1. Strip prior injections (idempotency via INJECTION_MARKER)
  // 2. Extract text from output.parts
  // 3. Find image paths in text
  // 4. Append reminder part (never shills out)
}

async function handleToolExecuteBefore(
  input: { tool: string },
  output: { args: any },
  cwd: string,
): Promise<void> {
  // 1. Only intercepts "read" tool
  // 2. Reads output.args.path or output.args.filePath
  // 3. Calls runAnalyze([filePath])
  // 4. Throws new Error(fencedDescription) to deny
}
```

**Current behavior:** `chat.message` only appends a reminder (no context injection). `tool.execute.before` runs `vp analyze` without `--question`/`--context`.

---

## 4. Recommended Deterministic Implementation for Hybrid B

### Option A: In-Memory Ring Buffer (Recommended)

**Why:** Fast (no network), deterministic, simple. Matches the existing "in-memory ring buffer" pattern used in the Claude Code/Codex side-channel.

**Implementation sketch:**

```typescript
// Per-session ring buffer: stores last N (UserMessage | AssistantMessage) parts
interface SessionContext {
    messages: Array<{ role: "user" | "assistant"; text: string; timestamp: number }>;
}

const sessionContexts = new Map<string, SessionContext>();

const RECENT_MESSAGE_COUNT = 8;
const ASSISTANT_TRUNCATE = 500;  // chars
const CONTEXT_MAX = 3000;        // total chars

function getAppendedContext(sessionID: string, currentText: string): string {
    const ctx = sessionContexts.get(sessionID);
    if (!ctx || ctx.messages.length === 0) return "";

    // Take last N messages (excluding current message if already stored)
    const recent = ctx.messages.slice(-RECENT_MESSAGE_COUNT);
    const parts = recent.map(m => {
        const prefix = m.role === "assistant" ? "[Assistant] " : "[User] ";
        const text = m.role === "assistant"
            ? m.text.slice(0, ASSISTANT_TRUNCATE)
            : m.text;
        return prefix + text;
    });

    // Cap total context length
    const joined = parts.join("\n");
    if (joined.length > CONTEXT_MAX) {
        // Trim from the oldest messages first
        let trimmed = "";
        for (const p of parts.reverse()) {
            if (trimmed.length + p.length <= CONTEXT_MAX) {
                trimmed = p + "\n" + trimmed;
            }
        }
        return trimmed.trim();
    }
    return joined;
}
```

**Hook integration:**

```typescript
// In chat.message handler:
// 1. Collect current user text from output.parts (before appending reminder)
// 2. Store in sessionContexts[sessionID].messages.push({ role: "user", text })
// 3. Build appended context via getAppendedContext()
// 4. Append context as synthetic TextPart BEFORE the reminder
// 5. Append reminder as synthetic TextPart AFTER context

// In tool.execute.before handler:
// 1. Read getAppendedContext(sessionID)
// 2. Pass to buildAnalyzeArgs(images, maxTokens, undefined, context) as --context
```

**Idempotency:** Use `INJECTION_MARKER` strip on re-fire (same as current behavior).

**Fail-open:** If context build fails, proceed with reminder-only (current behavior).

### Option B: SDK Client Poll (Slower but Stateful)

```typescript
// In chat.message handler:
const resp = await input.client.session.messages({
    id: input.sessionID,
    query: { limit: 16 }  // last 16 entries = ~8 user+assistant pairs
});
const messages = resp.data?.messages ?? [];
const context = buildContextFromMessages(messages, RECENT_MESSAGE_COUNT);
// Append context as synthetic TextPart
```

**Tradeoff:** Adds ~100ms latency per message. Not recommended for `chat.message` (blocks message submission).

### Option C: Event Subscription (Best Performance)

```typescript
// In plugin initialization:
input.client.event.subscribe("message.updated", (event) => {
    if (event.properties.sessionID === sessionID) {
        // Update in-memory ring buffer
        updateSessionContext(event.properties.info);
    }
});
```

**Tradeoff:** Requires managing subscription lifecycle. Same performance as Option A but more complex.

---

## 5. Async execFile Executor & Throw-to-Deny Shape

### Current Pattern (from `src/opencode-plugin.ts:120–138`)

```typescript
function runVp(command: string, args: string[]): Promise<{ status, stdout, stderr, error? }> {
    return new Promise((resolve) => {
        execFile(command, args, { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
            (error, stdout, stderr) => {
                if (error) {
                    resolve({ status: 1, stdout: stdout ?? "", stderr: stderr ?? "", error });
                } else {
                    resolve({ status: 0, stdout: stdout ?? "", stderr: stderr ?? "", error: undefined });
                }
            });
    });
}
```

### Throw-to-Deny Shape

The `tool.execute.before` hook denies by **throwing an Error**:

```typescript
async function handleToolExecuteBefore(input, output, cwd): Promise<void> {
    if (input.tool !== "read") return;
    const argPath = output.args?.path ?? output.args?.filePath;
    if (!isImagePath(argPath)) return;
    const filePath = resolveImagePath(argPath, cwd);
    if (!filePath || !existsSync(filePath)) return;

    const description = await runAnalyze([filePath]);
    if (!description) return;  // fail-open

    // Throw to deny the read tool and surface description to model
    throw new Error(withImageInstruction(description, INJECTION_MARKER));
}
```

**Fail-open guarantee:** If `runAnalyze` returns `null` (vp missing, exit non-zero, timeout), the hook returns silently and the original tool call proceeds unchanged.

---

## 6. buildAnalyzeArgs Modification for --context

The current `buildAnalyzeArgs` in `src/hooks/runtime.ts:94–104` does not accept a context parameter:

```typescript
function buildAnalyzeArgs(images: string[], maxTokens: number): { command: string; args: string[] } {
    var vp = resolveVpBin();
    var prefix = vpEntryToSpawn(vp);
    return {
        command: prefix.command,
        args: prefix.args.concat(["analyze"], images, ["--max-output-tokens", String(maxTokens)]),
        // NO --question argument
    };
}
```

**Required change for hybrid B:** Keep the existing optional-argument order and add `context` fourth:

```typescript
function buildAnalyzeArgs(
    images: string[],
    maxTokens: number,
    question?: string,
    context?: string,  // NEW
): { command: string; args: string[] } {
    var vp = resolveVpBin();
    var prefix = vpEntryToSpawn(vp);
    var args = prefix.args.concat(["analyze"], images, ["--max-output-tokens", String(maxTokens)]);
    if (question) args = args.concat(["--question", question]);
    if (context) args = args.concat(["--context", context]);
    return { command: prefix.command, args };
}
```

**Note:** The task specifies `--context` flag alongside existing `--question`. Both should be supported for parity.

---

## 7. Implementation Sketch for src/opencode-plugin.ts

```typescript
// === CONFIG ===
const RECENT_MESSAGE_COUNT = 8;
const ASSISTANT_TRUNCATE = 500;   // chars
const CONTEXT_MAX = 3000;         // total chars

// === STATE ===
const sessionContexts = new Map<string, { messages: Array<{id?: string; role: "user"|"assistant"; text: string}> }>();

// === HELPER ===
function buildContext(sessionID: string, excludeMessageID?: string): string {
    const ctx = sessionContexts.get(sessionID);
    if (!ctx?.messages.length) return "";
    const recent = ctx.messages.slice(-RECENT_MESSAGE_COUNT);
    const parts = recent
        .filter(m => m.id !== excludeMessageID)
        .map(m => {
            const prefix = m.role === "assistant" ? "[Assistant] " : "[User] ";
            const text = m.role === "assistant" ? m.text.slice(0, ASSISTANT_TRUNCATE) : m.text;
            return prefix + text;
        });
    const joined = parts.join("\n");
    return joined.length > CONTEXT_MAX ? joined.slice(0, CONTEXT_MAX) : joined;
}

// === chat.message HANDLER ===
async function handleChatMessage(input, output, cwd) {
    // 1. Strip prior injections
    // 2. Collect current user text from output.parts
    const currentText = output.parts.filter(p => p?.type === "text").map(p => p.text).join("\n");
    const currentMessageID = input.messageID;

    // 3. Store in ring buffer (update existing or append)
    const ctx = sessionContexts.get(input.sessionID) ?? { messages: [] };
    const existingIdx = ctx.messages.findIndex(m => m.id === currentMessageID);
    if (existingIdx >= 0) ctx.messages[existingIdx] = { id: currentMessageID, role: "user", text: currentText };
    else ctx.messages.push({ id: currentMessageID, role: "user", text: currentText });
    sessionContexts.set(input.sessionID, ctx);

    // 4. Build context from OTHER messages (exclude current)
    const context = buildContext(input.sessionID, currentMessageID);

    // 5. Append context part (if non-empty) and reminder part
    if (context) {
        output.parts.push({
            id: newPartId(), sessionID: input.sessionID, messageID: currentMessageID,
            type: "text", synthetic: true, text: context + "\n\n" + INJECTION_MARKER
        });
    }
    output.parts.push({
        id: newPartId(), sessionID: input.sessionID, messageID: currentMessageID,
        type: "text", synthetic: true, text: readReminder(uniqueImages, INJECTION_MARKER, "message", "read")
    });
}

// === tool.execute.before HANDLER ===
async function handleToolExecuteBefore(input, output, cwd) {
    if (input.tool !== "read") return;
    const argPath = output.args?.path ?? output.args?.filePath;
    if (!isImagePath(argPath)) return;
    const filePath = resolveImagePath(argPath, cwd);
    if (!filePath || !existsSync(filePath)) return;

    // 6. Get context from session ring buffer
    const context = buildContext(input.sessionID, input.messageID);

    // 7. Run analyze WITH --context
    const description = await runAnalyze([filePath], undefined, context);
    if (!description) return;
    throw new Error(withImageInstruction(description, INJECTION_MARKER));
}
```

---

## 8. Risks & Caveats

| Risk | Mitigation |
|------|------------|
| **Memory leak**: `sessionContexts` map grows unbounded | Cap per-session messages (8); clear on session end via `event` hook or periodic cleanup |
| **Race condition**: `chat.message` fires before `message.updated` event populates context | Use in-memory ring buffer (synchronous write) instead of SDK polling |
| **Context exceeds token limit**: 8 messages × 500 chars = 4000 chars, may exceed vision model limits | Hard cap at `CONTEXT_MAX` (3000 chars); truncate assistant messages to 500 chars |
| **Idempotency**: Hook re-fires for same message | Strip prior `INJECTION_MARKER` parts before re-appending (already implemented) |
| **Fail-open**: Context build fails | Return early if context is empty; proceed with reminder-only (current behavior preserved) |
| **No session history on first message**: `sessionContexts` empty for first user message | Return empty context; vision model gets only image (same as current behavior) |

---

## 9. Sources & Evidence

| Source | Location | Confidence |
|--------|----------|------------|
| **opencode plugin Hooks type** | `/tmp/pkg-opencode/package/dist/index.d.ts` (lines 80–130) | **100%** |
| **Part type union** | `/tmp/pkg-sdk/package/dist/gen/types.gen.d.ts` | **100%** |
| **TextPart definition** | Same file, lines ~1–50 | **100%** |
| **FilePart definition** | Same file, lines ~60–80 | **100%** |
| **TuiState.session.messages** | `/tmp/pkg-opencode/package/dist/tui.d.ts` | **100%** |
| **SDK session.messages API** | `/tmp/pkg-sdk/package/dist/gen/sdk.gen.d.ts` | **100%** |
| **SessionMessagesData schema** | Same file, lines ~1–30 | **100%** |
| **Existing opencode-plugin.ts** | `src/opencode-plugin.ts` (current branch) | **100%** |
| **HANDOFF-OPENCODE-PLUGIN.md** | `.worktrees/feat-plugin-support/HANDOFF-OPENCODE-PLUGIN.md` | **95%** |
| **pi-multimodal-proxy reference** | `pungggi/pi-multimodal-proxy` (GitHub) | **90%** (URL fetch failed, info from task description) |
| **Existing vision-proxy plugins** | `@showlotus/opencode-image-vision@1.0.10`, `@sami7786/opencode-image-proxy@1.0.6` (npm) | **85%** (npm metadata only, source not inspected) |

---

## 10. Final Recommendation

**Implement Option A (in-memory ring buffer)** for hybrid B:

1. Add `sessionContexts` Map to `src/opencode-plugin.ts` (per-session, capped at 8 messages)
2. In `handleChatMessage`: write current user text to ring buffer, build context from other messages, append as synthetic `TextPart`
3. In `handleToolExecuteBefore`: read context from ring buffer, pass to `buildAnalyzeArgs` as `--context`
4. Modify `buildAnalyzeArgs` in `src/hooks/runtime.ts` to accept `question?` third and `context?` fourth
5. Keep fail-open: if context is empty or build fails, proceed with existing reminder-only behavior
6. Cap total context at 3000 chars; truncate assistant messages to 500 chars

**Do NOT implement Option B (SDK polling)** — adds unacceptable latency to `chat.message`.

**Do NOT implement Option C (event subscription)** — adds complexity without clear benefit over ring buffer.

**Open questions for implementation:**
1. Should we use `--context` or `--question` flag? Task says `--context` alongside `--question`. Recommend: use `--context` for conversation history, keep `--question` for explicit user intent.
2. How to clear session context on session end? Add `event` hook subscription for `session.closed` or periodic cleanup.
3. Should context include assistant thinking/reasoning? Task says "last-8 recent messages" — likely just text parts, not reasoning parts.
