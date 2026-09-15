# Research Report: Claude Code Hook Context for `vp analyze --question`

**Date:** 2026-09-14
**Task:** Investigate whether Claude Code's Read tool PreToolUse hook receives context that can be forwarded to `vp analyze --question`

---

## Executive Summary

Claude Code's PreToolUse and UserPromptSubmit hooks receive `transcript_path` and `session_id` in their stdin JSON, but **do NOT receive** the current user prompt text as a structured field in PreToolUse events. The `UserPromptSubmit` event does provide `prompt` (confirmed via SDK types). The existing `includeContext` config key is **not dead code** — it is a documented, user-facing option (`docs/CONFIG.md:46`) wired into CLI analysis, but not consumed by hook scripts.

The hook currently calls `vp analyze` with only image paths — no `--question` flag is ever passed. Three viable options exist for forwarding context, each with distinct tradeoffs on privacy, fragility, latency, and implementation complexity.

**Confidence: High (90%)** on confirmed facts; moderate on inference about upstream API stability.

**Important corrections from initial assessment:**
1. `includeContext` is a documented config option, not dead code — it controls system prompt content for direct CLI calls but is not wired into the hook runtime.
2. Triggering analysis at UserPromptSubmit (my initial Option C) contradicts the established architecture where UserPromptSubmit is reminder-only and PreToolUse is the single analysis point.

---

## 1. Confirmed Facts About Claude Code Hook Event Schema

### Source: Authoritative SDK Types (Primary Evidence)

**File:** `~/.claude/security/agent-sdk-venv/lib/python3.13/site-packages/claude_agent_sdk/types.py`

```python
class BaseHookInput(TypedDict):
    session_id: str
    transcript_path: str
    cwd: str
    permission_mode: NotRequired[str]

class PreToolUseHookInput(BaseHookInput, _SubagentContextMixin):
    hook_event_name: Literal["PreToolUse"]
    tool_name: str
    tool_input: dict[str, Any]
    tool_use_id: str

class UserPromptSubmitHookInput(BaseHookInput):
    hook_event_name: Literal["UserPromptSubmit"]
    prompt: str
```

**Confirmed fields in PreToolUse events:**
- `hook_event_name` — `"PreToolUse"`
- `tool_name` — `"Read"`, `"Bash"`, `"Write"`, etc.
- `tool_input` — tool-specific args (e.g., `{ "file_path": "/tmp/img.png" }`)
- `tool_use_id` — unique tool invocation identifier
- `cwd` — current working directory
- `session_id` — session identifier
- `transcript_path` — path to session transcript file
- `permission_mode` — `"ask"` | `"allow"` | `"default"` etc.
- `agent_id`, `agent_type` — optional, for sub-agent attribution

**Confirmed fields in UserPromptSubmit events:**
- Same base fields as PreToolUse
- `prompt: str` — the current user prompt text (canonical field name)
  - Note: vision-proxy's hook correctly reads `event.prompt` (line 181 of `hook-script.ts`), matching the SDK schema

**What is NOT in any hook event:**
- ❌ No `message_history` / `conversation` array
- ❌ No `parent_context`
- ❌ No prompt text in PreToolUse events
- ❌ No conversation history

**Additional source corroboration:**
- `plugins/plugin-dev/skills/hook-development/scripts/test-hook.sh` — sample inputs show same structure
- `plugins/hookify/hooks/pretooluse.py` — production hook consuming `tool_name`, `tool_input`
- `plugins/plugin-dev/skills/hook-development/SKILL.md` — documentation confirming field names

**Confidence: 95%** — directly from authoritative SDK types and corroborated by repo examples.

---

## 2. Current vision-proxy Hook Implementation

### Hook Script (`src/hook-script.ts:177–199`)

```typescript
function runHook(event: Record<string, any> | null): void {
  if (!event) return;
  var eventName = event.hook_event_name != null ? event.hook_event_name : event.hookEventName;
  if (eventName === "UserPromptSubmit") {
    var prompt = typeof event.prompt === "string" ? event.prompt : "";
    var images = extractImagePaths(prompt);
    var sessionId = event.session_id != null ? event.session_id : event.sessionId;
    var refImages = resolveImageRefs(prompt, typeof sessionId === "string" ? sessionId : undefined);
    var allImages = images.concat(refImages);
    if (allImages.length === 0) return;
    emit("UserPromptSubmit", readReminder(allImages, undefined, "prompt", "Read"));
    return;  // Reminder only — NO vp analyze call
  }
  if (eventName === "PreToolUse") {
    var file = readToolFilePath(event);
    if (!file) return;
    var desc = runAnalyze([file]);  // <-- NO --question flag passed
    if (!desc) return;
    var toolName = event.tool_name != null ? event.tool_name : event.toolName;
    emit("PreToolUse", withImageInstruction(desc, undefined, toolName === "view_image" ? "view_image" : "Read"), "deny");
    return;
  }
}
```

### Analysis Args (`src/hooks/runtime.ts:94–104`)

```typescript
function buildAnalyzeArgs(images: string[], maxTokens: number): { command: string; args: string[] } {
  var vp = resolveVpBin();
  var prefix = vpEntryToSpawn(vp);
  return {
    command: prefix.command,
    args: prefix.args.concat(["analyze"], images, ["--max-output-tokens", String(maxTokens)]),
    // NO --question argument ever added
  };
}
```

**Key finding:** `--question` is never passed by any of the three hook adapters (Claude/Codex stdio hook, Pi extension, opencode plugin). The flag exists in the CLI (`command-runner.ts:645`) and flows through the analysis pipeline (`pipeline.ts:149`), but the hook call sites omit it entirely.

**Architecture constraint (confirmed):** UserPromptSubmit is intentionally reminder-only (no analysis, no latency). PreToolUse is the single analysis point. This is documented in `docs/INTEGRATIONS.md:11`:
> `UserPromptSubmit` - appends a static reminder to inspect each image mentioned in the prompt with the `Read` tool. Never shells out, so prompt submission is never blocked on a vision call.

**Confidence: 100%** — verified by grep across all source files and documentation.

---

## 3. The `includeContext` Config Key — Not Dead Code

**File:** `src/core.ts` (lines 43, 345, 383, 560, 598, 639, 691)
**Doc:** `docs/CONFIG.md:46`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `includeContext` | boolean | `false` | Whether to include extra context in the prompt. |

The env var is `VP_INCLUDE_CONTEXT`. It is parsed, persisted, and used by the CLI analysis pipeline when invoked directly. However:
- It is **not** referenced in `src/hooks/runtime.ts`
- It is **not** referenced in `src/hook-script.ts`
- It is **not** consumed by any hook-generated script

**Conclusion:** `includeContext` is a documented, user-facing config option that works for direct CLI invocations but is not wired into the hook runtime. It should be evaluated separately from the `--question` feature for hooks.

**Confidence: 100%** — verified by full grep across `src/` and `docs/`.

---

## 4. Existing Cross-Event Communication Pattern

The hook already uses a file-based side-channel for cross-event data sharing:

**Pattern:** `~/.claude/image-cache/<sessionId>/` directory
- **UserPromptSubmit** writes `[Image #N].png` reference files into this directory
- **PreToolUse** reads these files to resolve pasted/attached image references
- **Safety:** Session ID traversal guard prevents path abuse (`hook-script.ts:82`)

This pattern is documented in `docs/INTEGRATIONS.md:11` and tested in `src/hooks/hook-script.test.ts:99–126`.

A prompt side-channel using the same pattern (`~/.claude/image-cache/<sessionId>/vp-prompt.txt`) would be architecturally consistent.

---

## 5. Options for Forwarding Context to `vp analyze --question`

### Option A: Fixed Generic Question (Lowest Friction)

Always pass a fixed question like `"Describe what you see in this image in detail."` to `vp analyze --question`.

- **Pros:** Zero context dependency, always works, no new files or cross-event coordination
- **Cons:** Loses specificity — the answer is generic, not tailored to user intent
- **Privacy:** No additional risk (no extra data leaves the machine)
- **Latency impact:** None (same `vp analyze` call, just different question text)
- **Confidence for implementation: 95%**

### Option B: Side-Channel Prompt Cache (Recommended)

UserPromptSubmit writes `event.prompt` to a session-scoped file (e.g., `~/.claude/image-cache/<sessionId>/vp-prompt.txt`). PreToolUse reads it and passes as `--question`.

- **Pros:**
  - Captures actual user intent
  - Follows the **existing cross-event file pattern** (mirrors `image-cache/<sessionId>/` usage)
  - Uses `session_id` (stable, documented field)
  - No transcript parsing needed
  - Traversal guard already exists for `image-cache/<sessionId>/`
- **Cons:**
  - Adds minimal file I/O (~1–5ms)
  - Race condition if PreToolUse fires before UserPromptSubmit writes (mitigated by fail-open)
  - Stale prompt if user sends multiple prompts before reading images
- **Privacy:** Prompt written to local `.claude/` directory — same privacy boundary as existing image cache
- **Hook timeout risk:** Minimal — file I/O is fast, well within 30s timeout
- **Confidence for implementation: 80%** — pattern is established and consistent

### Option C: Transcript Parsing (Not Recommended)

Read `event.transcript_path` and parse the transcript JSON to extract the latest user message.

- **Pros:** Gets actual user intent from the authoritative session record
- **Cons:**
  - Transcript format is **unstable** — not part of any public API contract
  - Changelog notes `transcript_path` may point to wrong directory for resumed/forked sessions
  - Parsing adds latency and fragility
  - Finding the "latest user message before this tool call" requires heuristics
  - Risk of parsing failures (fail-open mitigates but degrades UX)
- **Privacy:** Transcript may contain sensitive code
- **Hook timeout risk:** Moderate — reading and parsing large JSON adds latency
- **Confidence for implementation: 50%** — works today but fragile to upstream changes

### Option D: Agent-Supplied Question (Plugin Level)

Require users to install a plugin rather than a raw hook to supply the question.

- **Pros:** Clean separation of concerns
- **Cons:** Heavier distribution burden; breaks "install hook, done" UX
- **Confidence: 40%** — significant architectural change

---

## 6. Risk Analysis

| Risk | Option A | Option B (Recommended) | Option C | Option D |
|------|----------|------------------------|----------|----------|
| Prompt injection | N/A | Low (local file, same session) | Medium (untrusted transcript text) | Low |
| Hook timeout | None | Minimal (~1–5ms) | Moderate (JSON parse) | None |
| Latency increase | None | None perceptible | +10–100ms | None |
| Fragility to upstream | None | Low (stable `session_id`) | High (unstable transcript) | Medium |
| Privacy concern | None | None (local, session-scoped) | Medium (reads full transcript) | None |
| Architectural consistency | N/A | High (follows existing pattern) | Medium | Low |

---

## 7. Recommendation

**Implement Option B** (side-channel prompt cache) as the primary path, with **Option A** (fixed generic question) as a safe fallback.

**Rationale:**
1. The side-channel approach uses `session_id` (stable, documented) and local file I/O (fast, reliable)
2. It follows the **existing cross-event communication pattern** already used in the codebase for `[Image #N]` resolution
3. Avoids the fragility of transcript parsing (unstable format, potential wrong path on resumed sessions)
4. The `session_id` traversal guard (`hook-script.ts:82`) provides path safety for the prompt file

**Implementation sketch:**
1. **UserPromptSubmit path** (after reminder emission): Write `event.prompt` to `~/.claude/image-cache/<sessionId>/vp-prompt.txt` (with existing traversal guard)
2. **PreToolUse path**: Read prompt file if it exists; pass to `buildAnalyzeArgs()` as `--question`; fall back to no `--question` if absent (maintains current behavior)
3. **Cleanup**: Optionally delete prompt file after successful read to avoid stale prompts

**Do NOT implement Option C** (transcript parsing) — the transcript format is undocumented and unstable; the side-channel achieves the same goal with more stable foundations.

**Revisit `includeContext` separately** — it is a valid CLI feature but not directly applicable to the hook workflow.

---

## 8. Open Questions

1. **Side-channel timing edge cases:** If PreToolUse fires before UserPromptSubmit completes (e.g., session resume, rapid tool calls), the prompt file may not exist. Fail-open handles this but the user gets no `--question` context. Should be tested empirically.
2. **Multi-prompt sessions:** If user sends multiple prompts before reading images, which prompt to use? Simplest: overwrite with latest. Alternative: key by image path or timestamp.
3. **`includeContext` intended behavior:** Documented as "include extra context in the prompt" but the mechanism is unclear from code inspection. Needs investigation before any feature decision.
4. **Prompt file cleanup:** Should the prompt file be deleted after PreToolUse reads it, or retained for potential re-analysis?

---

## 10. Final Recommendation: Side-Channel Only (No Transcript Parsing)

### Core principle

**Only the current user prompt matters for image analysis.** The vision model does not need conversation history — it needs to know what question to answer about the image. Claude Code's model already has that natively via its context window; the vision proxy does not, and `--question` fills that exact gap.

### Why not transcript export?

Evidence gathered from actual Claude Code transcripts:

1. **Format is explicitly internal.** SDK types (`claude_agent_sdk/types.py`) state: "That union is internal and adapters should treat entries as pass-through blobs." Parsing it is guaranteed to break on upstream changes.

2. **Transcript size is unpredictable.** In a short session (26 entries), user+assistant text totaled ~1,500 tokens. In a long session it can exceed 50K+ tokens. There is no stable upper bound.

3. **`transcript_path` is unreliable.** Changelog notes it "may point to the wrong directory for resumed or forked sessions." Relying on it for correctness-critical behavior is a structural risk.

4. **Privacy exposure is disproportionate.** A transcript contains every tool result, every model thinking block, every past user message including credentials and proprietary code. Forwarding any meaningful slice of it into `--question` amplifies that exposure to the vision API.

5. **Heuristic extraction is fragile.** Finding "the latest user message before this tool call" requires scanning backwards from the current position, skipping tool results, handling sidechains, and dealing with multi-part messages. Each heuristic is a future bug vector.

6. **You don't actually need it.** Claude Code's model doesn't use the transcript either — it uses the in-memory conversation. The vision model doesn't need the full history; it needs the user's intent. That intent is already captured by `event.prompt` at `UserPromptSubmit`.

### Concrete comparison

| | Side-channel (Option B) | Transcript export |
|---|---|---|
| What the vision model sees | Image + current prompt | Image + entire session history |
| Data needed | 1 file write, 1 file read (~1ms) | JSON parse over potentially huge file |
| Stability | `session_id` is documented and stable | Transcript format is internal, unsupported |
| Privacy | Prompt only (user chose to say it) | Full history including credentials, code, reasoning |
| Failure mode | Missing file → no `--question` (fail-open) | Parse error → no `--question` (fail-open) |
| Architectural fit | Follows existing `image-cache/<sessionId>/` pattern | No precedent in the codebase |

### Recommended implementation

**Primary path — side-channel (high confidence):**

1. In `UserPromptSubmit` (after reminder emission, before return): write `event.prompt` to `~/.claude/image-cache/<sessionId>/vp-prompt.txt` using the existing traversal guard from `imageCacheDir()` (`hook-script.ts:82`)
2. In `PreToolUse` Read path: read the file; if present, pass as `--question` to `buildAnalyzeArgs()`; if absent, omit (current behavior)
3. Optionally overwrite on each UserPromptSubmit (simplest, covers the common case); alternatively delete after read to avoid stale prompts on multi-turn sessions where the user changes topic between prompts

**Do not implement transcript parsing** as a primary or fallback path. The risk/reward ratio is unfavorable.

### When to revisit

If users later request richer context (e.g., "the last 3 turns of conversation"), consider a bounded, best-effort transcript enrichment as an optional second path — but only after the side-channel is solid and tested. At that point, cap the extraction to N turns and keep it strictly fail-open.

---

## 11. Sources & Evidence (Updated)

| Source | Location | Confidence |
|--------|----------|------------|
| **Authoritative SDK types** | `claude_agent_sdk/types.py` (lines 277–346) | **100%** |
| **Transcript format warning** | `claude_agent_sdk/types.py` (`SessionStoreEntry` docstring: "internal", "pass-through blobs") | **100%** |
| Hook documentation | `plugins/plugin-dev/skills/hook-development/SKILL.md` (anthropics/claude-code) | 95% |
| Test fixture schema | `plugins/plugin-dev/skills/hook-development/scripts/test-hook.sh` | 95% |
| Production hook example | `plugins/hookify/hooks/pretooluse.py` | 90% |
| Official docs | https://code.claude.com/docs/en/hooks | 70% (partial render) |
| vision-proxy hook impl | `src/hook-script.ts:177–199`, `src/hooks/runtime.ts:94–104` | 100% |
| Cross-event pattern doc | `docs/INTEGRATIONS.md:11` | 100% |
| `includeContext` config | `src/core.ts:43,345,383,560,598,639,691` + `docs/CONFIG.md:46` | 100% |
| `--question` CLI support | `src/command-runner.ts:178,244,645`, `src/analysis/pipeline.ts:149` | 100% |
| Cache key with question hash | `src/core.ts:1838` — `?q=${questionHash}` | 100% |
| **Actual transcript samples** | `~/.claude/projects/*.jsonl` (2 sessions inspected) | **100%** |
| **Transcript format evidence** | Entry types: `user`, `assistant`, `attachment`, `last-prompt`, `file-history-snapshot`, `file-history-delta` | **100%** |
| **Transcript size data** | Short session: ~1,500 tokens user+assistant text across 26 entries | **100%** |

---

## 12. pi-multimodal-proxy 竞品分析（p Cummings/pi-vision-proxy）

### 项目概况
- **仓库：** https://github.com/p Cummings/pi-vision-proxy（后更名为 pi-multimodal-proxy）
- **Stars：** 23⭐
- **定位：** Pi 平台专用图像/视频/音频描述代理，通过 `PI_VISION_PROXY_INCLUDE_CONTEXT` 配置注入上下文

### 关键发现：它如何注入上下文

与我们的 `--question` 侧信道方案最相关的配置：

| 配置项 | 说明 |
|--------|------|
| `PI_VISION_PROXY_INCLUDE_CONTEXT` | 默认 `true`，将最近 8 条消息（截断）随图片一并发送到视觉模型 |
| `/multimodal-proxy context on|off` | 运行时开关 |
| `analyze_image` 工具 | 支持针对图片的精准问答（类似我们的 `--question`），支持 crop |

```
隐私条款原文（来自 README）：
"Recent conversation context (last 8 messages, truncated) is uploaded with
the image unless you set /multimodal-proxy context off or
PI_VISION_PROXY_INCLUDE_CONTEXT=false. Disable it for sensitive sessions."
```

### 三种方案机制对比

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    视觉上下文三种方案机制对比                                     │
├─────────────────┬───────────────────────────┬───────────────────────────────────┤
│                 │ vision-proxy (current)     │ pi-multimodal-proxy               │
│ 上下文来源      │ 无                         │ 最近 8 条对话消息                   │
│ 注入方式        │ —                         │ 插入系统 prompt，随图片一并发送给视觉模型│
│ 发送时机        │ —                         │ before_agent_start 阶段            │
│ 用户可感知      │ 视觉模型返回通用描述        │ 视觉模型有上下文，但 token 浪费       │
│ 隐私风险        │ 最低                       │ 高（最近 8 条消息可能含敏感信息）       │
│ 精准度          │ 无                         │ 模糊（整个上下文窗口）                │
├─────────────────┼───────────────────────────┼───────────────────────────────────┤
│ vision-proxy    │                           │                                   │
│ (proposed)      │ 侧信道文件                  │                                   │
│                 │ 1. UserPromptSubmit 写     │                                   │
│                 │    event.prompt →          │                                   │
│                 │    ~/.claude/image-cache/  │                                   │
│                 │    <sessionId>/vp-prompt.txt│                                  │
│                 │ 2. PreToolUse(Read) 读     │                                   │
│                 │    文件内容 → --question    │                                   │
│                 │    "用户的问题"             │                                   │
│                 │ 3. vp analyze 图片         │                                   │
│                 │    + --question            │                                   │
└─────────────────┴───────────────────────────┴───────────────────────────────────┘
```

### Side-Channel 工作原理详解

```
时间线：
  T1: 用户发送 prompt "帮我看看这张截图里的 bug"
  │   UserPromptSubmit hook 触发
  │   → 写 event.prompt = "帮我看看这张截图里的 bug"
  │   → 到 ~/.claude/image-cache/<sessionId>/vp-prompt.txt
  │
  T2: Claude Code 调用 Read(image_path.png)
  │   PreToolUse hook 触发
  │   → 读 ~/.claude/image-cache/<sessionId>/vp-prompt.txt
  │   → 读到时 "帮我看看这张截图里的 bug"
  │   → 调用 vp analyze image_path.png --question "帮我看看这张截图里的 bug"
  │
  T3: vp analyze 调用视觉模型
  │   输入: 图片 + 用户问题 → 返回针对性描述
```

**关键点：**
- 侧信道是**文件 I/O**，不是网络传输
- 文件路径用 `session_id` 隔离，不会串到其他 session
- 如果文件不存在（PreToolUse 先于 UserPromptSubmit），fail-open，行为与当前一致
- 用户只看到图片 + 他们自己写的问题被转发，隐私风险最低

### 为什么 pi-multimodal-proxy 的方案不够好？

| 问题 | pi-multimodal-proxy 方案 | vision-proxy proposed 方案 |
|------|--------------------------|---------------------------|
| Token 效率 | 8条消息 ≈ 几百到几千 token | 只有当前 prompt ≈ 几十到几百 token |
| 隐私 | 把最近 8 条对话发给第三方视觉模型 | 只发用户当前意图，不暴露历史 |
| 精准度 | 模型需要自己从 8 条消息里找相关部分 | 直接告诉模型"回答这个问题" |
| 可控性 | `INCLUDE_CONTEXT=true/false` 整开关 | 精确控制每一张图片传什么 question |

**pi-multimodal-proxy 的 `INCLUDE_CONTEXT` 思路值得学习**（证明方向正确），但实现上不如我们的 side-channel + `--question` 方案精准、安全、高效。

---

## Summary for Coordinator

**Verdict: Implement side-channel prompt cache (Option B). Do NOT implement transcript export.**

**Why:**
- Claude Code's `Read(image)` works because the LLM has full conversation history in its context window natively — no forwarding needed
- The vision proxy's gap is different: the vision model only sees the image, not the user's intent
- `--question` fills that exact gap with the ONE thing the vision model needs: the current user prompt
- Side-channel writes `event.prompt` to `~/.claude/image-cache/<sessionId>/vp-prompt.txt` at UserPromptSubmit, reads it at PreToolUse — follows the existing cross-event pattern already used for `[Image #N]` resolution
- Transcript export is fragile (internal format), risky (privacy exposure of full session), and unnecessary (you only need the current prompt, not 50K+ token histories)
- pi-multimodal-proxy proves the direction is right, but its INCLUDE_CONTEXT approach (8 messages as system prompt) is less precise, less private, and less efficient than our side-channel + --question

**Evidence from actual Claude Code transcripts:**
- Entry types confirmed: `user`, `assistant`, `attachment`, `last-prompt`, `file-history-snapshot`
- Short session (26 entries): ~1,500 tokens user+assistant text
- Long sessions: 50K+ tokens — too large for `--question`, too risky to forward
- SDK explicitly warns transcript format is internal and unstable

**Files updated:**
- `docs/research-hook-context.md` — Sections 10-12: final recommendation, sources, competitive analysis
- `.lavish/research-hook-context.html` — Added Section 12 (competitive analysis table) and updated sources table

## 12. pi-multimodal-proxy 竞品分析（p Cummings/pi-vision-proxy）

### 项目概况
- **仓库：** https://github.com/p Cummings/pi-vision-proxy（后更名为 pi-multimodal-proxy）
- **Stars：** 23⭐
- **定位：** Pi 平台专用的图像/视频/音频描述代理，注入描述到模型上下文

### 关键发现：它如何注入上下文

与我们的 `--question` 侧信道方案**最相关的配置**：

| 配置项 | 说明 |
|--------|------|
| `PI_VISION_PROXY_INCLUDE_CONTEXT` | 默认 `true`，开启后**将最近 8 条消息（截断）随图片一起发送到视觉模型** |
| `/multimodal-proxy context on\|off` | 运行时开关 |
| `analyze_image` 工具 | 支持针对图片的精准问答（类似我们的 `--question`），支持 crop |

```
隐私条款原文（来自 README）：
"Recent conversation context (last 8 messages, truncated) is uploaded with
the image unless you set /multimodal-proxy context off or
PI_VISION_PROXY_INCLUDE_CONTEXT=false. Disable it for sensitive sessions."
```

### 架构对比：pi-multimodal-proxy vs vision-proxy

| 维度 | pi-multimodal-proxy | vision-proxy（当前） | vision-proxy（Proposed） |
|------|---------------------|----------------------|--------------------------|
| 上下文策略 | 最近8条消息随图片发送 | 无上下文 | --question 传当前用户意图 |
| 机制 | 系统 prompt 注入 + 图片同时上传 | 仅上传图片 | 仅上传图片 + --question |
| 可配置性 | 有 on/off 开关 | 无 | 有（通过 hook 实现） |
| 精准度 | 模糊（整个上下文窗口） | 无 | 精准（当前用户问题） |
| 隐私 | 上传8条消息到第三方 | 无 | 不上传额外数据 |
| 平台 | Pi 专属 | Claude Code hook | Claude Code hook |

### 为什么我们的方案优于 pi-multimodal-proxy 的上下文策略

1. **`--question` 比上下文注入更精准**：pi-multimodal-proxy 把最近 8 条消息都发给了视觉模型，浪费 token 且引入无关噪声。我们只需一个当前用户问题。
2. **不增加隐私风险**：pi-multimodal-proxy 的策略会把对话内容上传到第三方，我们的方案只上传图片 + 一个 `--question` 字符串（本身就是发给用户的）。
3. **token 效率更高**：最近 8 条消息可能数百至数千 token；`--question` 只有一条用户意图。

### 结论

pi-multimodal-proxy 的 `INCLUDE_CONTEXT` 功能**证实了"视觉模型需要上下文"的设计方向是正确的**，但它的实现方式（完整上下文注入）比我们的 `--question` 方案更粗糙。我们的侧信道方案在精准度和隐私上都更优。

---

## 13. 综合结论

### 最终推荐方案：Side-Channel + `--question`

```
UserPromptSubmit → 写 event.prompt 到 ~/.claude/image-cache/<sessionId>/vp-prompt.txt
PreToolUse(Read) → 读文件 → 传 vp analyze --question "<prompt>"
```

**理由：**
1. Claude Code `Read(image)` 自带上下文是因为 LLM 有完整的 conversation history — vision-proxy 的 gap 是视觉模型只有图片没有意图
2. `--question` 填补了这个 gap，传入的就是 `event.prompt`（当前用户意图）
3. pi-multimodal-proxy 用更粗糙的"最近8条消息注入"实现了类似目标，证明方向正确，但我们方案更精准、更轻量、更安全
4. 侧信道遵循已有的 `image-cache/<sessionId>/` 跨事件通信模式

**File updated:** `docs/research-hook-context.md` — Sections 10–12 contain the earlier analysis. Section 14 (below) adds ctxrs/ctx comparison and the revised cross-agent maintainability verdict.

---

## 14. ctxrs/ctx 竞品分析：为什么不适用

### 项目定位

**仓库：** https://github.com/ctxrs/ctx
**Stars：** 1,107⭐
**定位：** 本地编码 Agent session 历史的**回溯搜索工具**，不是运行时上下文注入系统。

### 核心机制

ctx 的工作原理与 vision-proxy 的需求完全不同：

```
ctxrs/ctx 架构：
  ~/.claude/*.jsonl  →  后台 daemon 自动读取并索引（Tantivy）
  ~/.codex/*.jsonl   →  同上
  ~/.pi/*.jsonl      →  同上
       ↓
  ctx search "failed migration"     ← 用户手动查询
  ctx blame src/file.ts --lines 118 ← 用户追溯代码来源
  ctx show session <id>             ← 用户查看 transcript

关键声明（来自 README）：
  "ctx does not require hooks or any code running inside the agent process."
  "Automatic indexing is on by default and keeps the index current as those
   history sources change."
```

### 与 vision-proxy 的对比

| 维度 | ctxrs/ctx | vision-proxy 需求 |
|------|-----------|-------------------|
| **目的** | 事后搜索已结束的 session 历史 | 实时拦截 Read(image)，注入当前意图 |
| **触发时机** | 用户显式调用 `ctx search/show/blame` | 每次 PreToolUse(Read) 自动触发 |
| **是否用 hook** | ❌ 明确不需要 hooks | ✅ 必须通过 hooks 感知 Read(image) |
| **上下文方向** | agent 读历史（agent → ctx → 模型） | hook → vision 模型（反向注入） |
| **实时性** | 延迟索引（daemon 后台） | 毫秒级（hook 同步阻塞） |
| **跨 agent** | 支持 13+ agent（只读已存在的日志） | 需要每个 agent 的 hook 适配层 |

### 结论：ctxrs/ctx 不解决 vision-proxy 的问题

ctxrs/ctx 解决的是"**Agent 忘记之前做了什么**"的问题，而 vision-proxy 需要解决的是"**视觉模型看不懂用户意图**"的问题。两者是完全不同的场景。

ctx 的架构哲学是"**被动读取、事后搜索**"；vision-proxy 需要的是"**主动注入、实时响应**"。

---

## 15. 跨 Coding Agent 可维护性分析（用户反馈后的修订）

### 用户的顾虑

> "i don't like side-channel to be honest, i feel that approach is hard to maintain across different coding agents"

这个顾虑是合理的。side-channel 依赖每个 agent 的特定路径和事件格式：
- Claude Code：`~/.claude/image-cache/<sessionId>/vp-prompt.txt`
- Codex：不同的目录结构，不同的 hook 格式
- Pi：完全不同的事件生命周期（input/context/tool_result）
- OpenCode：Bun 运行时，不同的插件系统

### 三种方案的跨 Agent 可维护性对比

| 维度 | Side-Channel（Option B） | Transcript 8-Message（Option C） | ctxrs/ctx |
|------|--------------------------|----------------------------------|-----------|
| **跨 Agent 适配成本** | 高（每个 agent 需要独立的文件路径 + 写入逻辑） | 中（transcript 格式各 agent 不同，但模式一致） | N/A（只读，不适用于此问题） |
| **实现复杂度** | 低（写文件 + 读文件） | 中（解析 transcript JSON 提取最后 N 条） | N/A |
| **稳定性风险** | 低（session_id 是稳定的） | 中（transcript 格式可能变化） | N/A |
| **隐私** | 高（只发当前 prompt） | 中（发最近 8 条消息） | N/A |
| **token 效率** | 高（只有当前 prompt） | 中（8 条消息 = 更多 token） | N/A |
| **跨 Agent 一致性** | 低（每个 agent 的 side-channel 实现不同） | **高（所有 agent 都用 transcript 读取）** | N/A |

### 修订后的推荐

基于跨 Agent 可维护性的考量，推荐**混合方案**：

```
主路径（高置信度）：
  UserPromptSubmit → 写 event.prompt 到 side-channel 文件
  PreToolUse(Read) → 读文件 → --question "<prompt>"

备用路径（跨 Agent 一致）：
  PreToolUse(Read) → 如果 side-channel 文件不存在
                   → 从 transcript_path 读取最后 8 条用户消息
                   → 拼成 --question "<最近8条用户消息>"
```

**为什么混合方案更优：**

1. **Side-channel 是当前 agent 的最优路径**：精确、低 token、隐私好
2. **Transcript fallback 提供跨 Agent 一致性**：不依赖每个 agent 的 side-channel 实现
3. **pi-multimodal-proxy 已验证 8-message 模式的可行性**：证明从 transcript 提取上下文是可行的
4. **Fail-open 保证安全**：两种路径都缺失时，退回到当前的无 question 行为

### 实现优先级

```
P0: 实现 side-channel 主路径（Claude Code）
P1: 添加 transcript fallback（Claude Code，作为双保险）
P2: 评估是否值得为其他 agent 单独实现 side-channel
P3: 如果其他 agent 的 side-channel 成本过高，fallback 到 transcript-only 策略
```

### 关键洞察

> **ctxrs/ctx 证明了 transcript 是可搜索、可解析的结构化数据**，这降低了 transcript-based fallback 的可靠性风险。但 ctx 本身不适用于 vision-proxy 的实时注入需求。
>
> **pi-multimodal-proxy 的 8-message 模式是跨 agent 一致的备用方案**，已在 Pi 平台上验证。侧信道是单个 agent 的最优路径，transcript fallback 是跨 agent 的保底方案。

---

## 16. 修订：Transcript 8-Message 策略（用户决策）

### 最终选择：Option A — Last 8 Raw Messages（User + Assistant 混合）

**理由：**
1. **每次 Read(image) 的上下文依赖不同** — 有时是 user 的问题驱动，有时是 assistant 的上一次响应驱动
2. **长 session 和短 session 都适用** — 8 messages 提供了灵活的窗口
3. **与 pi-multimodal-proxy 对齐** — 已验证的模式，降低实现风险

### "8 Messages" 的实际含义

```
Last 8 JSONL entries (从当前时间倒序):
  [USER]     "帮我看看这张截图"
  [ASSISTANT]  "好的，让我分析..."
  [USER]     "这个错误是什么意思"
  [ASSISTANT]  "从日志看..."
  [USER]     "再看下这张图"
  [ASSISTANT]  "我看到了..."
  [USER]     "修复一下"
  [ASSISTANT]  "好的，我来修改..."
```

**即 4 个完整对话轮次（4 user + 4 assistant）**

### Token 规模预估

| 场景 | 字符数 | 英文 token 估算 | 中文 token 估算 |
|------|--------|----------------|----------------|
| 短 session | ~100 chars | ~25 tokens | ~50 tokens |
| 正常 session | ~3,000 chars | ~750 tokens | ~1,500 tokens |
| 长/heavy session | ~10,000 chars | ~2,500 tokens | ~5,000 tokens |

**注意：** 单个 verbose assistant response 可能达到 2,000+ tokens，所以实际 token 消耗可能远超预期。

### 实现方案

```typescript
// 从 transcript 提取最后 N 条消息
function extractContextFromTranscript(transcriptPath: string, messageCount: number = 8): string {
  const entries = parseTranscript(transcriptPath);
  const recent = entries.slice(-messageCount);
  return recent
    .map(e => {
      const text = extractTextContent(e.message.content);
      return text ? `[${e.type.toUpperCase()}] ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

// 使用示例
const context = extractContextFromTranscript(event.transcript_path, 8);
const args = buildAnalyzeArgs(images, maxTokens, context);
// args: ['analyze', 'image.png', '--max-output-tokens', '2000', '--question', '...context...']
```

### 与 Side-Channel 的关系

```
执行优先级：
1. 先尝试 Side-Channel（快速、精确、低 token）
   → 如果存在 vp-prompt.txt，直接使用
2. 如果 Side-Channel 不存在，fallback 到 Transcript 8-Message
   → 解析 transcript，提取最后 8 条消息
3. 如果两者都失败，退回到当前行为（无 --question）
```

### 跨 Agent 一致性优势

| Agent | Side-Channel 实现 | Transcript Fallback |
|-------|------------------|-------------------|
| Claude Code | ✅ 已验证路径 | ✅ 可用（transcript 格式已知） |
| Codex | ❓ 需探索 | ✅ 可用（需要适配 parser） |
| Pi | ❓ 需探索 | ✅ 已验证（pi-multimodal-proxy） |
| OpenCode | ❓ 需探索 | ✅ 可用（需要适配 parser） |

**Transcript fallback 是唯一能保证所有 agent 都有 context 的策略。**
