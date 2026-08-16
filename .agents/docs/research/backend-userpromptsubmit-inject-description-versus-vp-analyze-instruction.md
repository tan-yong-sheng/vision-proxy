---
type: research
title: UserPromptSubmit inject description versus vp analyze instruction
description: Compare injecting an image description directly via UserPromptSubmit with injecting instructions for the agent to run `vp analyze` itself.
area: backend
tags: [cli, hooks, userpromptsubmit, claude-code, codex, integration, ux]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-09-15"
related:
  - ../plans/backend-binary-as-hook-vision-proxy-integration.md
---
# UserPromptSubmit inject description versus vp analyze instruction

## Question

For the `UserPromptSubmit` hook, should vision-proxy:

A. Run `vp analyze` inside the hook and inject the resulting image description as `additionalContext` (current approach)?

B. Inject a system instruction that tells the agent "there is an image at /path; run `vp analyze /path` if you need a description"?

## Findings

### How `UserPromptSubmit` works

Both Claude Code and Codex pass the user prompt to the hook on stdin and accept an `additionalContext` string in the response. The agent receives that context as a system note alongside the prompt. It does **not** transform the prompt text itself; it only adds context.

This means the hook cannot literally rewrite `"/tmp/img.png"` into `"a red square on white"` inside the user's message. The image path remains in the prompt; the description is added as a separate note.

### Option A: inject the description

The hook extracts image paths from the prompt, shells out to `vp analyze`, and returns the fenced description as `additionalContext`.

**Pros**

- Fully automatic. The user does not have to ask the agent to analyze anything.
- Works with text-only models because the description is already text; the agent never needs to read the image file.
- Fast when cached; the hook can return before the agent starts reasoning.
- Prevents the agent from wasting a tool call on `Read(image.png)`.

**Cons**

- The agent sees a description but does not know where it came from unless we label it.
- If the description is wrong or missing nuance, the agent cannot easily re-run analysis with a different question.
- The hook pays the LLM cost/latency for every image in the prompt, even if the agent would not have used the image.
- If the hook fails, the agent gets no context at all (unless we also inject a fallback instruction).

### Option B: inject a `vp analyze` instruction

The hook detects image paths and returns `additionalContext` like:

> The prompt references an image at `/tmp/img.png`. To obtain a description, run `vp analyze /tmp/img.png [--question <question>]`.

**Pros**

- Gives the agent control. It decides whether it needs the description and what question to ask.
- Avoids paying for LLM calls that the agent might not need.
- Keeps the hook stateless and cheap; no API key is needed in the hook environment.
- The agent can re-run `vp analyze` with a tailored question if the first description is insufficient.

**Cons**

- The agent must have shell access and `vp` on PATH. In restricted or sandboxed environments it may not be able to run the command.
- Adds friction. The user sees the agent making an extra tool call (`Bash vp analyze ...`) instead of getting an immediate answer.
- Does **not** solve the `Read(image.png)` problem for text-only models. If the agent ignores the instruction and tries to read the image directly, it still fails.
- Relies on the agent following the instruction, which is not guaranteed.

### Why Option A is better for the UserPromptSubmit hook

The purpose of the hook is to make image-containing prompts work seamlessly in agents that cannot otherwise see images. Option A achieves that; Option B merely suggests a workaround.

Specifically:

1. **Text-only models.** Claude Code with a non-vision model will try `Read(image.png)` and fail. Option A prevents that by giving it a description before it decides what to do.
2. **User experience.** The user pastes an image path and asks a question; they expect the agent to understand the image, not to see the agent ask itself to run another command.
3. **Hook runtime is cheap.** The hook runs once per turn and can use a local cache. The cost is comparable to the agent calling `vp analyze` itself, but with fewer round-trips.

### Where Option B makes sense

Option B is useful as a **fallback** when the hook cannot analyze the image (no API key, timeout, unsupported format). In that case the hook can emit:

> Could not analyze `/tmp/img.png` automatically. If needed, run `vp analyze /tmp/img.png`.

It can also make sense in a future MCP/tool mode where vision-proxy registers an explicit `analyze_image` tool that the agent can call on demand.

## Recommendation

Keep Option A as the primary `UserPromptSubmit` behavior: run `vp analyze` inside the hook and inject the description.

Add a small fallback note only when analysis fails or is skipped, telling the agent it can run `vp analyze <path>` manually.

This matches the current shim design and should be preserved in the `vp analyze --hook` implementation.

## Open questions

- Should the injected description include the exact `vp analyze` command that produced it, so the agent can reproduce or verify the result?
- Should we expose a user preference (`VP_HOOK_MODE=describe|instruct`) for users who prefer Option B?
- For PreToolUse, is there any value in Option B? No, because PreToolUse blocks the original `Read` and must supply a replacement result.
