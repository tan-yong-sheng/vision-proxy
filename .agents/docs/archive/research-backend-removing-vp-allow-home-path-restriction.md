---
type: research
title: Removing VP_ALLOW_HOME path restriction
description: Evaluate whether to remove the VP_ALLOW_HOME opt-in and allow image paths anywhere on the filesystem.
area: backend
tags: [security, cli, path-restriction]
status: complete
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-09-14"
superseded_by: ../plans/backend-remove-vp-allow-home-path-restriction.md
related: []
---
# Removing VP_ALLOW_HOME path restriction

## Question

Can we remove the `VP_ALLOW_HOME` restriction so `vp analyze` accepts image paths anywhere on the filesystem?

## Findings

### 1. What the restriction does

`src/core.ts::isPathAllowed` decides whether an image path can be read:
- Always allowed: paths inside `os.tmpdir()` and the current working directory.
- Allowed only when `VP_ALLOW_HOME=1`: paths inside the user's home directory.
- Otherwise: any local absolute path is allowed unless Windows drive access is disabled.

The default behavior keeps the CLI from reading files under `~/.ssh`, `~/.aws`, `~/.gnupg`, and other sensitive home directories unless the user explicitly opts in.

### 2. Why it exists

`vp` is not only run by a human at the terminal. It is also invoked automatically by:
- `vp hook install claude-code` / `vp hook install codex` — UserPromptSubmit shims that run on every prompt.
- `vp integration install pi` — a Pi extension that registers an `analyze_image` tool.

When an agent calls `vp analyze` automatically, the path restriction limits the blast radius if the model tries to inspect private files.

### 3. Removing it is a security/convenience trade-off

**Pros of removing the restriction:**
- Users can analyze screenshots or images saved in `~/Downloads`, `~/Pictures`, `~/Desktop`, etc., without setting an env var.
- Fewer support questions about "path outside allowed directories."
- Behaves like most normal CLI tools (`cat`, `file`, `convert`).

**Cons of removing the restriction:**
- Any installed hook or extension can read arbitrary home-directory files if the model supplies the path.
- Sensitive files such as private keys, credentials, and browser profiles become accessible without an explicit opt-in.
- The user may not realize the agent has this capability.

### 4. Alternative designs

| Option | Behavior | Security |
|---|---|---|
| **A. Remove restriction entirely** | Any path allowed. | Lowest |
| **B. Keep `VP_ALLOW_HOME` but default to `1`** | Home allowed by default; users can disable with `VP_ALLOW_HOME=0`. | Medium |
| **C. Context-aware default** | Allow home for direct CLI invocation; keep restriction when called from a hook or extension. | Higher |
| **D. Add a CLI flag instead of env var** | `--allow-home` / `--allow-anywhere`. | Higher |
| **E. Keep current behavior** | Home requires explicit `VP_ALLOW_HOME=1`. | Highest |

### 5. How to detect caller context

If we choose option C, we could detect hook/extension context by:
- Checking for hook-specific env vars such as `CLAUDE_CODE_HOOK`, `CODEX_HOOK`, or the Pi `ExtensionAPI` context.
- Adding a `--from-agent` flag that hooks/extensions pass internally.
- Checking if stdin/stdout is a TTY and the call is interactive.

None of these are perfect, and adding context detection increases complexity.

## Recommendation

Do **not** remove the restriction entirely.

The safest improvement is **Option D**: keep the env var but also add an explicit CLI flag such as `--allow-home` or `--no-path-restrictions`, so direct CLI users can opt in per invocation without exporting an environment variable.

If the goal is maximum convenience, **Option B** (default `VP_ALLOW_HOME=1`) is acceptable, but it should be paired with a clear security note in the README and AGENTS docs.

## Open questions

- Is the primary friction direct CLI usage, or hook/extension usage?
- Would users accept a `--allow-home` flag, or do they expect home paths to work by default?
- Should the restriction also apply to the Pi extension's `analyze_image` tool, or should that tool be more permissive because the user explicitly installed it?
