#!/usr/bin/env node
/**
 * Vision proxy UserPromptSubmit shim for the Codex CLI.
 *
 * Codex fires this hook on every user prompt, piping the event JSON to stdin.
 * We extract image paths from the prompt, shell out to `vp analyze` (capped at
 * Codex's default ~2500-token preview limit), and print the fenced description
 * as `hookSpecificOutput.additionalContext`.
 *
 * Codex caps model-visible hook output at roughly 2500 tokens by default; larger
 * output is spilled to disk and only a preview is shown. So the CLI is asked to
 * cap output at 2000 tokens unless overridden via VP_MAX_OUTPUT_TOKENS. The hook
 * also enforces its own timeout so it never exhausts the agent's turn.
 *
 * Fail-open: on any error we exit 0 with no stdout and a note on stderr, so the
 * agent proceeds unchanged. The description is attacker-controlled text, so the
 * fence stays on inside `vp analyze`.
 */
import { runShim } from "./shared.mjs";

// __VP_VERSION__PLACEHOLDER__

// Codex shows ~2500 tokens by default; stay under the preview limit.
const MAX_OUTPUT_TOKENS = Number(process.env.VP_MAX_OUTPUT_TOKENS ?? 2000);

runShim(["--max-output-tokens", String(MAX_OUTPUT_TOKENS)]);
