---
type: research
title: vision-proxy review run operational lessons and follow-up decisions
description: Comprehensive post-mortem of review run operational failures and decision matrix for typebox and maxToolCallsPerTurn.
area: backend
tags:
  - review-gate
  - no-mistakes
  - post-mortem
  - typebox
  - maxToolCallsPerTurn
status: active
created: "2026-08-15"
updated: "2026-08-15"
stale_after: "2026-09-14"
visual: .lavish/vision-proxy-review-lessons.html
related:
  - ../qa/backend-vision-proxy-post-migration-merge-review.md
  - ../bugs/backend-pi-extension-undeclared-typebox-dependency.md
  - ../bugs/backend-core-dead-max-tool-calls-per-turn-surface.md
---

# vision-proxy review run operational lessons and agent skills workflow

## Question

What systemic workflow improvements and skill guardrails should be established across `agents-docs`, `review-gate`, and `worktrunk-orca-delegation` based on the operational breakdowns observed during the `vision-proxy` review run?

## Findings

### Core Agent Skills Workflow Breakdowns & Solutions

#### 1. Diff-Scope Gating in Review Loops (`review-gate`)
- **Breakdown:** When the base branch (`configurable-analyze-image-limit`) advanced with docs and skill updates (`c1c6b16`, `72351a0`, `da91d9a`, `8fb7804`), the agent immediately triggered a full `no-mistakes axi run` pipeline.
- **Root Cause:** Failure to evaluate the diff scope of base branch commits before invoking heavy review machinery.
- **Protocol:**
  1. Inspect `git diff <prev-base>..<new-base> --stat`.
  2. If the diff touches only `.agents/docs/`, `.agents/skills/`, or markdown documentation, merge the updated base into the preview worktree.
  3. Run fast local checks (`pnpm test`, `pnpm run typecheck`, `fallow audit`).
  4. Skip full `no-mistakes` re-review if code paths are unchanged.

#### 2. Interactive Approval Detection & TOON Output Parsing (`review-gate`)
- **Breakdown:** Polling scripts waiting on `no-mistakes axi status` checked only for terminal outcomes (`passed`, `failed`, `aborted`, `cancelled`), entering an infinite wait loop when status remained `running (review: fixing)` with `findings: 2 awaiting`.
- **Root Cause (TOON Format Impedance):**
  - `no-mistakes axi status` emits **TOON (Token-Oriented Object Notation)** rather than JSON or YAML.
  - TOON structures tabular data with compact headers (e.g., `steps[9]{step,status,findings,duration_ms}:`, `findings[2]{id,severity,file,action,description}:`).
  - Standard JSON parsers fail with `SyntaxError`, and ad-hoc grep/regex easily miss nested `gate` and `run.findings` states or mistake `run.status: running` for active computation rather than a parked interactive gate.
- **Solution — Decoding TOON via `@toon-format/toon`:**
  - The official `@toon-format/toon` package provides a lossless `decode(rawToon)` API.
  - Calling `decode(execSync("no-mistakes axi status"))` produces a fully typed JavaScript object with `run`, `branch_sync`, `gate`, and `gate.findings` cleanly populated.
  - This allows poller scripts to deterministically check `parsed.gate?.findings?.some(f => f.action === "ask-user")` or `parsed.run?.findings?.includes("awaiting")`.
- **Protocol:**
  1. For TypeScript / JavaScript / Bun tools: Use `import { decode } from "@toon-format/toon"` to decode CLI status outputs.
  2. For Bash environments: Use daemon IPC socket via `scripts/poll-no-mistakes.sh` or pipe through `@toon-format/cli`.
  3. When `awaiting > 0` or `ask-user` findings exist, immediately break polling wait and invoke `no-mistakes axi respond --action <action>`.


#### 3. Grounded Commit Attribution (`worktrunk-orca-delegation`)
- **Breakdown:** Speculating that unexpected commits on the base branch were authored by automated subagents or external tools.
- **Root Cause:** Guessing provenance instead of checking git metadata.
- **Protocol:**
  1. Always run `git log -n 5 --format='%h %an <%ae> %s'` to ground author attribution before making assumptions.

#### 4. Disposable Worktree Lifecycle Hygiene (`worktrunk-orca-delegation`)
- **Breakdown:** Created `.worktrees/preview-merge` when base moved, leaving `.worktrees/int-merge` dangling and stale.
- **Root Cause:** Missing preview worktree lifecycle reuse.
- **Protocol:**
  1. Re-use existing preview worktrees by pulling base forward (`git merge <base>`).
  2. If a new preview worktree must be spawned, promptly delete the obsolete worktree using `git worktree remove` or `wt remove`.

#### 5. Persistent Finding Tracking via Bug Corpus (`agents-docs`)
- **Breakdown:** Unresolved warnings from review runs were treated as transient TUI alerts and not filed in `.agents/docs/bugs/`, causing them to re-surface as surprises on subsequent runs.
- **Root Cause:** Skipping the `agents-docs` failure triage and bug recording lifecycle.
- **Protocol:**
  1. Any warning or debt item not resolved in the active turn must be filed in `.agents/docs/bugs/<area>-<slug>.md` with `pre-existing: true` and linked from the QA dossier.


---

### Code Issue 1: `src/pi-extension.ts` Undeclared `typebox` Dependency

#### Context
`src/pi-extension.ts` contains `PI_EXTENSION_SOURCE`, written to `~/.pi/agent/extensions/vision-proxy.ts` via `vp integration install pi`. It imports `{ Type } from "typebox"` (line 27) and constructs parameter definitions using `Type.Object(...)`.

`package.json` does not include `typebox` in `dependencies` or `peerDependencies`.

#### Technical Options

| Option | Approach | Pros | Cons | Recommendation |
|---|---|---|---|---|
| **A1** | Replace `Type.Object(...)` with raw JSON Schema | Zero runtime dependencies; completely decouples from Pi's internal resolver; eliminates module load failures | Slightly more verbose schema definition | **Recommended** |
| **A2** | Add `typebox` to `dependencies` in `package.json` | Keeps `Type.Object` syntax | Adds unnecessary dependency to standalone CLI package; conflicts with minimal dependency goal | Not recommended |
| **A3** | Document runtime assumption in `AGENTS.md` / `README.md` | Zero code changes | Leaves potential runtime crash if Pi environment does not expose `typebox` | Acceptable fallback |

#### Recommended Solution (Option A1)
Replace TypeBox schema construction in `PI_EXTENSION_SOURCE` with standard JSON Schema:
```typescript
parameters: {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Absolute or project-relative paths to image files.",
    },
    question: {
      type: "string",
      description: "Optional question to analyze the image against.",
    },
    format: {
      type: "string",
      description: "Optional grounding format override (e.g. qwen_pixels).",
    },
  },
  required: ["paths"],
}
```

---

### Code Issue 2: `src/core.ts` Dead `maxToolCallsPerTurn` Surface

#### Context
`src/core.ts` declares:
- `VisionConfig.maxToolCallsPerTurn: number` (line 48)
- `DEFAULT_CONFIG.maxToolCallsPerTurn: -1` (line 357)
- `CONFIG_KEYS` / `CONFIG_NUMERIC_KEYS` entries (lines 379, 554)
- `EnvOverrides.maxToolCallsPerTurn` & `VP_MAX_TOOL_CALLS_PER_TURN` (lines 569, 579)
- `fallbackToolCallsCap` fallback logic (lines 659, 690)
- Exported helper `maxToolCallsPerTurn(configured?: number): number` (lines 816-820)

None of `src/commands/analyze.ts`, `src/cli.ts`, `src/adapter.ts`, `src/shims/*.mjs`, or `src/pi-extension.ts` ever call or enforce this limit.

#### Technical Options

| Option | Approach | Pros | Cons | Recommendation |
|---|---|---|---|---|
| **B1** | Cleanly remove dead `maxToolCallsPerTurn` surface | Removes dead code; eliminates confusion; aligns types with actual runtime behavior | Minor breaking change if external users set `VP_MAX_TOOL_CALLS_PER_TURN` | **Recommended** |
| **B2** | Wire `maxToolCallsPerTurn` into `analyze` or Pi extension | Makes setting functional | Artificial for a standalone CLI tool; turn-level limits belong in agent harnesses | Not recommended |
| **B3** | Keep as reserved config and track in `.agents/docs/bugs/` | Zero risk to existing configs | Leaves dead surface in codebase | Acceptable interim |

#### Recommended Solution (Option B1)
Prune `maxToolCallsPerTurn` across `src/core.ts`, `src/config.ts`, and associated unit tests, since per-turn caps are strictly the responsibility of calling agent harnesses (Claude Code, Codex, Pi).

---

### Proposed Skill Modifications & Script Architecture

To prevent these 5 failure modes permanently while maintaining pure Bash (`.sh`) uniformity across skill scripts, the following updates are planned:

#### 1. Standardizing on Pure Bash (`.sh`) for Review Scripts (`poll-no-mistakes.sh`)
- **Keep `.sh` Architecture:**
  - All skill scripts remain pure Bash (`.sh`), matching `waker.sh`, `apply_recovery.sh`, and `poll-no-mistakes.sh`.
  - In `poll-no-mistakes.sh`, TOON CLI output is decoded directly to JSON using `@toon-format/cli` or an inline Node/Bun decoder:
    ```bash
    # Decode TOON output to JSON in bash
    STATUS_JSON=$(no-mistakes axi status | npx -y @toon-format/cli 2>/dev/null || node -e 'import("@toon-format/toon").then(t=>process.stdin.on("data",d=>console.log(JSON.stringify(t.decode(d.toString())))))')
    ```
  - This allows `poll-no-mistakes.sh` to seamlessly parse both the Unix domain socket JSON-RPC and CLI TOON output without writing parsing instructions into `SKILL.md`.

#### 2. `.agents/skills/review-gate/SKILL.md` & `REFERENCE.md`
- **Diff-Scope Gating & Second-Review Cost Gate:**
  - When a preview worktree has already passed review once and the base branch advances:
    1. Inspect base diff: `git diff <old-base>..<new-base> --stat`.
    2. **Doc/Skill-Only Diffs:** Automatically merge base into preview worktree, run local tests (`pnpm test && fallow audit`), and **skip full `no-mistakes` review**.
    3. **Code Diffs Outside PR Scope:** Prompt user with cost/time estimate (variable ~20–60+ min run, high token burn) before triggering a second full review.
- **Automated Bug Corpus Routing:**
  - Mandate that any un-remedied `ask-user` findings or pre-existing warnings at review completion are automatically filed into `bugs/` with `pre-existing: true`.

#### 3. `.agents/skills/worktrunk-orca-delegation/SKILL.md` & `REFERENCE.md`
- **Parameterized Worktree Naming Format (`qa/<batch-slug>`):**
  - Prohibit literal example names (e.g. `preview-merge`).
  - Mandate the standard format: `qa/<batch-slug>` (e.g. `qa/vp-post-migration-merge`).
- **Single Preview Worktree Invariant:**
  - Maintain exactly one preview worktree per integration batch.
  - Merge base updates in place; prune the worktree promptly upon completion (`wt remove qa/<batch-slug>`).
- **Commit Provenance Verification:**
  - Mandate `git log -n 5 --format='%h | %an <%ae> | %cr | %s'` before hypothesizing about external agents.

#### 4. `.agents/skills/agents-docs/SKILL.md` & `REFERENCE.md`
- **`pre-existing: true` Definition & Reliable Detection Protocol:**
  - **Definition:** A defect/warning that existed on the base branch prior to the PR. It does NOT block the current PR merge; it is recorded in `bugs/<area>-<slug>.md` with `owning_branch: <branch>` for a dedicated fix track.
  - **Reliable Detection Method:**
    1. **Base Reproducibility:** Inspect file on base (`git show <base-branch>:<file>`).
    2. **Diff Attribution:** Run `git diff <base-branch>...HEAD -- <file>`. If offending lines were not modified/introduced in this PR's diff, it is `pre-existing: true`.
    3. **Historical Tracing:** Run `git log -S "<symbol>" <base-branch>` to confirm original commit on base.



---

## Recommendation / Decision

1. **Adopt Second-Review Cost Gate:** Require user approval before spending 1 hour and high tokens on re-reviews when base touches non-conflicting code; automatically fast-path doc/skill-only diffs.
2. **Adopt TOON Decoding:** Use `@toon-format/toon` `decode()` in all JS/TS agent review tools.
3. **Enforce Single Preview Worktrees:** Strictly update preview worktrees in place and tear down stale ones.
4. **Automate Bug Filing:** Persist all review warnings into `bugs/` with `pre-existing: true`.
5. **Apply Skill Updates:** Update `review-gate`, `worktrunk-orca-delegation`, and `agents-docs` with these exact contracts.

