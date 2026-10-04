# vision-proxy plan

Open items. Each entry: what, why, evidence, and what's left.

---

## 1. Drop the `Read` PreToolUse matcher from the Codex registration

**Status:** confirmed worth doing, NOT implemented (deferred).

**What:** Codex's `hooks.json` currently registers three `PreToolUse` matchers —
`Read`, `view_image`, `Bash`. The `Read` matcher can never fire, because Codex
has no `Read` tool. Remove it for the Codex host only.

**Evidence** (cloned `openai/codex` at `/tmp/codex-src`, tag HEAD `b741e48`):

- `codex-rs/core/src/tools/handlers/` lists every tool handler:
  `apply_patch.rs`, `current_time.rs`, `plan.rs`, `shell_spec.rs`,
  `view_image.rs`, `unified_exec.rs`, `tool_search.rs`, `mcp.rs`,
  `wait_for_environment.rs`, ... — **no `read.rs`, no `Read` tool**.
- The image tool is `view_image`: `core/src/tools/handlers/view_image.rs:74`
  `ToolName::plain("view_image")`.
- Confirmed in both installed binaries by `strings`: `core/src/tools/handlers/view_image.rs`
  present in Codex 0.160.0 (standalone) and 0.147.0 (ACP).

**Why it's harmless but wasteful:** a matcher that matches nothing costs one
no-op config entry. It does not cause the `400` bug (the `view_image` matcher
does fire — verified live: `hook: PreToolUse Blocked`).

**Scope note:** do NOT touch the Claude Code registration — Claude Code *does*
have a `Read` tool, and `Read` is its image path. The matcher list is already
per-host (`makeTsHookCommand` / spec matchers in `src/integrations/catalog.ts`),
so this is a Codex-spec change only.

**Related find (unrelated but worth surfacing):**
`codex-rs/core/src/tools/handlers/view_image.rs:54` contains its own guard —

```rust
"view_image is not allowed because you do not support image inputs"
```

Codex *can* refuse image reads for non-vision models, but the guard did not
fire in our failing runs, because Codex logged
`Model metadata for poolside/laguna-xs-2.1 not found. Defaulting to fallback metadata`.
With unknown model metadata Codex falls back and allows the call, so the request
reaches the provider and returns `400 This model does not support multimodal
inputs`. This is a Codex-side gap; vision-proxy is the layer that has to cover it.

**Left to do:** remove `Read` from the Codex spec matcher list in
`src/integrations/catalog.ts`, update the Codex section of `docs/INTEGRATIONS.md`
("registers three hooks"), and adjust the expectations in
`src/commands/integration.test.ts`.
