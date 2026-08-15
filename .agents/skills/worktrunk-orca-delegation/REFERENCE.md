# Worktrunk + Orca Delegation Reference

This document provides extended technical reference notes, sandbox configuration guidelines, cleanup workflows, and operational lessons learned for [`worktrunk`](https://github.com/max-sixty/worktrunk) (`wt`) and [`orca`](https://github.com/stablyai/orca).

## Sandbox setup for linked worktrees

Linked git worktrees share `.git` references with the primary repository.
In a nono security sandbox, worker agents require the `@git:common-dir` grant to read the main repository's `.git` directory.

Add the dynamic token to the worker profile configuration:

```json
{
    "extends": "default",
    "meta": { "name": "worktree-worker" },
    "workdir": { "access": "readwrite" },
    "filesystem": {
        "allow": ["@git:common-dir"],
        "bypass_protection": ["@git:common-dir"]
    }
}
```

Verify profile access before dispatching:

```bash
nono why --profile <profile> --workdir <worktree-path> --path <main-repo-path>/.git --op readwrite
```

If dynamic tokens are unavailable, fall back to creating top-level worktrees directly via Orca:

```bash
orca orchestration worker-start \
  --worktree new-top-level \
  --base-branch <base-branch> \
  --name <branch-name> \
  --agent claude \
  --task <task-id> \
  --run <run-id> \
  --json
```

## Worktree & terminal cleanup workflows

Always clean up worktrees and worker terminals when tasks complete or fail:

- Release worker terminal slot & archive transcript: `orca orchestration worker-release --dispatch <dispatch-id> --json`
- Close terminal UI pane: `orca terminal close --terminal <handle> --json`
- Automated merge & auto-remove: `wt merge <target-branch>`
- Remove worktree directory and delete merged branch: `wt remove <branch-name>`
- Remove unmerged worktree & kill background processes: `wt remove <branch-name> --reap`
- Force-delete unmerged branch & dirty worktree: `wt remove <branch-name> -f -D`
- Inspect worker dispatch state: `orca orchestration worker-show --dispatch <id> --json`
- Read worker terminal log: `orca orchestration worker-read --dispatch <id> --limit 50 --json`
- Stop a hung worker process: `orca orchestration worker-stop --dispatch <id> --json`
- Reply to an agent prompt: `orca orchestration reply --id <msg-id> --body "..." --json`

## Model alias pinning

`--model` accepts bare tier aliases (`haiku`, `sonnet`, `opus`, `fable`) that resolve on the configured account to the latest model of that tier.
To pin an alias to a concrete model, set the matching env var to a model id:

- `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `ANTHROPIC_DEFAULT_SONNET_MODEL`
- `ANTHROPIC_DEFAULT_OPUS_MODEL`
- `ANTHROPIC_DEFAULT_FABLE_MODEL`

Alternatively, use the `defaultModel` key or the `modelOverrides` map in Claude settings (`settings.json`).
`modelOverrides` maps a Claude model id to a provider-specific id, for example a Bedrock inference profile ARN.

## Why prompt submission sometimes needs a nudge

`worker-start` (and `dispatch --inject`) submits a task by writing the prompt into the agent terminal and then, about 500ms later, writing a single Enter (CR) byte.
This is the only submission mechanism, so when that trailing Enter is lost or lands while the TUI is not ready, the task text sits in Claude's input line unsubmitted and the worker never sends `worker_done`.

Three things make the Enter easy to lose:

- The `tui-idle` readiness gate (`terminal wait --for tui-idle`) is a quiet-period heuristic (~3s of no output) and can fire during init phases before the prompt input is live - more likely when several agents boot at once.
- A fresh worktree's first-run trust/onboarding screen can absorb the Enter.
- The Enter write is not retried; a transient `terminal_not_writable` loses it.

Recovery (see SKILL.md section 5.5) is to wait for `tui-idle`, confirm the prompt did not submit, then push the Enter: `orca terminal send --terminal <handle> --text "" --enter --json`.

## Detailed workflow reference

### 3. Create a linked worktree for each worker (preferred)

**Preferred: linked worktrees** - lighter, share the repo, and are the real worktrunk setup. Requires the `@git:common-dir` nono grant so the worker can read the main repo's `.git` (see Sandbox note).

```bash
# Pre-approve project hooks for non-interactive agent execution
wt config approvals add --yes

# Create worktree off base branch (runs pre-start hooks defined in .config/wt.toml)
wt switch --create <branch-name> --base <base-branch> --no-cd
```

#### Prime fresh worktrees to skip first-run screens (reduces lost-Enter)

The first time Claude launches in a fresh worktree, a first-run trust/onboarding screen can absorb the trailing Enter that submits the dispatch, so the task text sits in the prompt unsubmitted.
Prime each brand-new worktree once so real dispatch into it does not hit that screen:

```bash
orca terminal create --worktree branch:<branch-name> --command claude --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal close --terminal <handle> --json
```

The acknowledgment is stored per worktree, so this only needs doing the first time, and only when the trust prompt is enabled.

#### Skill overlaying and hook timing

After creating a worktree, overlay skills from the orchestrator's checkout with `rsync -au --ignore-existing`.
Do not use a Worktrunk `post-start` hook for skill overlaying: hooks execute before source-branch merges, leaving synced files untracked and blocking subsequent `git merge` operations.
Sync skills after the initial merge pass completes.

### 4. Launch agent terminals in the worktrees

#### Claude (interactive TUI)

Launch and dispatch in one step:

```bash
# Linked worktree (must already exist; see step 3)
orca orchestration worker-start \
  --worktree branch:<branch-name> \
  --agent claude --task <task-id> --run <run-id> --json

# Full clone / top-level workspace fallback
orca orchestration worker-start \
  --worktree new-top-level \
  --base-branch <base-branch> \
  --name <branch-name> \
  --agent claude --task <task-id> --run <run-id> --json
```

This creates the terminal, dispatches the task, and returns the terminal handle in one step.

#### Dispatch multiple workers without racing startup

`worker-start` submits the task by writing the prompt and then, about 500ms later, a separate Enter keystroke.
Orca verifies neither, and the `tui-idle` readiness gate (`terminal wait --for tui-idle`) is a quiet-period heuristic - no output for ~3s - that can fire before Claude's prompt is truly accepting submits.
When several agents boot on the same machine at once, this lost-Enter race gets much more likely.

So, when launching multiple independent workers, stagger them instead of firing every `worker-start` in one burst.
Launch workers one at a time with a short pause, and optionally gate each launch on the previous terminal reaching `tui-idle` (the strongest guard against the readiness race):

```bash
orca orchestration worker-start --worktree branch:<worker-a> --agent claude --task <task-a> --run <run-id> --json
sleep 5
orca orchestration worker-start --worktree branch:<worker-b> --agent claude --task <task-b> --run <run-id> --json
```

```bash
# Or, gate each launch on the previous terminal reaching tui-idle
orca terminal wait --terminal <handle-a> --for tui-idle --timeout-ms 60000 --json
orca orchestration worker-start --worktree branch:<worker-b> --agent claude --task <task-b> --run <run-id> --json
```

#### Pick a worker model by task complexity

`worker-start` forwards `--model` to the fresh agent terminal, so you can size the worker to the task.
For Claude agents, `--model` takes bare tier aliases that resolve on your configured account to the latest model of that tier, so retargeting what an alias points to needs no worktree or task change.
To pin an alias to a concrete model, see [Model alias pinning](REFERENCE.md#model-alias-pinning).

| Task complexity                                                                             | Model alias      |
| ------------------------------------------------------------------------------------------- | ---------------- |
| Low: mechanical, well-scoped (renames, test-id updates, small copy edits, dependency bumps) | `--model haiku`  |
| Medium: ordinary feature work, single-file bug fixes (default)                              | `--model sonnet` |
| High: cross-cutting refactors, architecture decisions, deep root-cause analysis             | `--model opus`   |

Codebase scouting spans two tiers, so spec it deliberately.
Shallow locates (find a symbol, trace a call site, read a config value) are mechanical and fit the Low tier.
Architectural scouting (understand a subsystem, map component interactions, decide where a feature should live) is analysis, and scout output feeds every downstream worker, so never go below the Medium tier.

Add the flag to the dispatch:

```bash
orca orchestration worker-start \
  --worktree branch:<branch-name> \
  --agent claude --task <task-id> --run <run-id> \
  --model opus --json
```

Constraints:

- `--model` applies only to a fresh agent terminal and cannot combine with `--terminal <handle>`; reusing a terminal keeps its launch-time model.
- The dispatch receipt reports the requested and effective model under `launch.requested` and `launch.effective`, so verify which model actually booted.

### 5. Dispatch tasks

If a task was previously blocked or failed, set it back to ready:

```bash
orca orchestration task-update --id <task-id> --status ready --json
```

Or reuse an existing terminal:

```bash
orca orchestration worker-start --terminal <terminal-handle> --task <task-id> --json
```

Before dispatching, clear any stale terminal on the target worktree:

```bash
# List terminals for the branch worktree
orca terminal list --worktree branch:<branch-name> --json

# Inspect a suspicious terminal
orca terminal show --terminal <terminal-handle> --json

# Close it if it is unresponsive or no longer needed
orca terminal close --terminal <terminal-handle> --json
```

A leftover terminal from a previous session can cause `terminal_handle_stale` and block dependent tasks.

### 5.5 Submission gate - MANDATORY verify before moving on

`worker-start` submits the task by pasting the prompt and then, about 500ms later, writing a separate Enter (CR) keystroke.
The Enter write is not verified and not retried, and the `tui-idle` gate that precedes it can fire before Claude's prompt is ready - so occasionally the task text lands in the input line but the Enter never lands as "submit".
The worker then sits silently at a blank prompt and will not send `worker_done` on its own.
This is silent-stall **Mode A**: dispatch status stays `dispatched` forever, `worker.state` stays `ready`, `stage: input_accepted`, and the terminal preview shows a bare `❯` with no tool activity.

**Run this verification after every `worker-start`, before any other dispatch or `check --wait`.** Skipping it lets Mode A failures stay invisible for the entire run.

```bash
# Step 1: let the agent settle after the dispatch injection
orca terminal wait --terminal <terminal-handle> --for tui-idle --timeout-ms 60000 --json

# Step 2: inspect the preview to confirm the task text actually submitted
orca terminal show --terminal <terminal-handle> --json
#   submitted    -> Claude left the idle prompt and shows working/tool activity.
#   NOT submitted -> the preview still shows a bare/blank idle prompt after the dispatch text
#                    (or no output at all since the dispatch).

# Step 3: if it did not submit, push the missing Enter (empty text + --enter = just Enter):
orca terminal send --terminal <terminal-handle> --text "" --enter --json
```

Wrap step 3 in a bounded retry: re-wait `--for tui-idle`, re-check the preview, and send Enter again, up to 2-3 attempts.
Only after that, treat the worker as genuinely stuck and fall into the health-check/recovery path (`worker-show`, read, close/reset/redispatch).
Use `worker-read --dispatch <dispatch-id> --limit 50 --json` instead of the preview if you want the full output.

Sending an extra Enter when the prompt already submitted is usually harmless while Claude is mid-turn, but do the check in step 2 first so the nudge only goes to the unsubmitted case.

### 5.6 Distinguishing silent-stall from working-silent

A `dispatched` task can stall for three different reasons. Use the terminal record, not `dispatch.last_heartbeat_at` (which is unreliable - always `null` in our runs). The liveness signal is the terminal preview plus `lastOutputAt`.

| Signal                                                      | Diagnosis                                                   | Action                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Preview `❯` AND `lastOutputAt` > 2m ago                     | **Mode A** - lost-Enter / silent stall                      | `terminal send --text "" --enter`, re-verify                                     |
| Preview shows tool activity AND `lastOutputAt` < 5m ago     | **Mode B** - worker working, dispatch metadata stale        | `terminal send "report progress: one-sentence status, then continue"`            |
| Preview shows "please proceed" or static checkmark          | **Mode C** - worker finished but did not call `worker_done` | `terminal send "commit and run: orca orchestration worker_done --dispatch <id>"` |
| `worker.last_error` non-null OR `terminal.connected: false` | **Mode D** - process dead                                   | `terminal close`, `task-update --status ready`, `worker-start` again             |

Run this decision table whenever `check --wait` times out without a message, or as part of the periodic waker tick (see 6.1).

### 5.7 Commit gate - MANDATORY before `worker_done`

`worker_done` reports success; it does not commit code.
A worker can produce files, list them in `filesModified`, and call `worker_done` while the branch remains at the base commit with everything sitting uncommitted in the worktree.

Make commit a hard precondition in every dispatch prompt:

```bash
git add -A
git commit -m "<type>(<scope>): <what changed>"
```

If there is genuinely nothing to commit, the worker must explain why before calling `worker_done`.

As the coordinator, do not trust the `filesModified` payload.
Verify commits exist before acknowledging the delivery:

```bash
# Must be > 0; if not, the work is still uncommitted in the worktree.
git rev-list --count <base-branch>..<branch>
```

This check belongs in section 7 before you release the terminal.

### 6. Poll for completion

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

Process the whole Delivery before acknowledging it, then wait again until all dispatches settle.

If a stale delivery keeps replaying (for example, after a runtime restart or a rejected `worker_done`), acknowledge it explicitly:

```bash
orca orchestration check --ack <delivery_id> --json
```

### 6.1 Waker - time-driven health-check loop

The poll above is event-driven and never wakes without a message, so Mode A and Mode B stalls stay invisible for the entire run.
Add a time-driven waker that fires on a fixed cadence and runs every rule under `scripts/rules/`.

```bash
# Launch waker supervisor in a managed Orca terminal pane
orca terminal create \
  --title "waker for <run-id>" \
  --command ".agents/skills/worktrunk-orca-delegation/scripts/waker.sh --run <run-id> --max-ticks 12" \
  --json

# Or run a single tick manually to health-check/unstick workers immediately
.agents/skills/worktrunk-orca-delegation/scripts/waker.sh --run <run-id> --single-tick
```

Launch the waker inside a dedicated Orca terminal pane using `orca terminal create`, or asynchronously via your agent harness.
The supervisor automatically checks failure rules, deduplicates recovery actions, and applies targeted recoveries (e.g. lost Enter, progress nudge, worker_done prompt, or dead process reset).
The waker supports `--max-ticks <n>` and `--timeout-minutes <n>` to cleanly bound background runtime.
Do **not** use untracked `nohup`, `&`, `disown`, or unmanaged detached processes.
A foreground wait via `orca orchestration check --wait` with one-shot `waker.sh --single-tick` on timeout is also fully supported.

### 6.2 scripts/ directory layout

A dedicated `scripts/` directory under the skill, so monitoring rules are pluggable. The waker shells out to each rule in order; rules are pure functions from `(RUN_ID) -> action JSON`.

```
.agents/skills/worktrunk-orca-delegation/
  SKILL.md
  REFERENCE.md
  scripts/
    waker.sh                              # the time-driven iterator
    apply_recovery.sh                     # JSON action -> orca terminal send / close
    rules/
      duration-loop-check.sh              # workers with no progress > 30 min
      keyword-stall-detector.sh           # scan terminal preview for known stall phrases
      mid-turn-stop-detector.sh           # worker exited mid-tool without worker_done
      dispatch-heartbeat-stale.sh         # dispatch.last_heartbeat_at old AND terminal idle
      # append-only: new rules drop in here, no edits to the waker
```

**Rule contract.** Each rule is a bash script that:

- Takes `RUN_ID` as `$1`.
- Reads orca state via `orca orchestration` / `terminal` commands.
- Exits `0` and prints one JSON line per recovery action, OR exits `0` with no output (silent).
- Never exits non-zero; errors get logged but do not break the waker loop.

```bash
# Example: scripts/rules/dispatch-heartbeat-stale.sh
RUN_ID="$1"
orca orchestration task-list --run "$RUN_ID" --json \
  | jq -c '.result.tasks[] | select(.status == "dispatched")' \
  | while read -r TASK; do
      TASK_ID=$(echo "$TASK" | jq -r .id)
      LAST_AGE=$(echo "$TASK" | jq -r '.result.last_heartbeat_at // "never"')
      # ... decide, emit JSON, or stay silent
    done
```

Why `scripts/` over inline: append-only rule addition (no waker edits), per-rule unit tests in `scripts/rules/__tests__/`, rules can be shared with other orchestration workflows.

### Health-check a dispatched worker

A worker may crash, close, or hang without sending `worker_done`.
Run a health check every ~30 minutes, or whenever `check --wait` times out, to catch silent stalls.

List dispatched tasks and get the active dispatch context:

```bash
orca orchestration task-list --run <run-id> --json
orca orchestration dispatch-show --task <task-id> --json
```

Inspect worker health with the dispatch id:

```bash
orca orchestration worker-show --dispatch <dispatch-id> --json
```

Treat the worker as dead if any of these hold:

- `dispatch.status` is `failed`
- `worker.last_error` is non-null
- `terminal.connected` is `false`
- `observation.status` is not `running`

For ambiguous cases (terminal connected but no visible progress), read the tail output:

```bash
orca orchestration worker-read --dispatch <dispatch-id> --limit 50 --json
```

If the worker is dead, close its terminal and reset the task so the poller can redispatch:

```bash
orca terminal close --terminal <terminal-handle> --json
orca orchestration task-update --id <task-id> --status ready --json
```

A connected terminal with `worker.state == "ready"` and `observation.status == "running"` may also be idle at the Claude prompt instead of actively working.
Check the terminal preview:

```bash
orca terminal show --terminal <terminal-handle> --json
```

If the preview shows the dispatch/preamble text still sitting at the prompt with a bare idle line under it and no tool activity, this is the unsubmitted-Enter failure, not a slow worker.
Run the nudge from section 5.5 (`terminal send --text "" --enter`, after a `--for tui-idle` wait) before assuming the worker is dead.

If the preview says something like "please proceed" or the title is a static checkmark, Claude has likely finished and is waiting.
Send a terminal message telling it to commit and call `worker_done`:

```bash
orca terminal send --terminal <terminal-handle> \
  --text "If the task is ready, commit the changes and run: orca orchestration worker_done --dispatch <dispatch-id>" \
  --enter
```

### 7. Reuse or release workers & worktree teardown

After a `worker_done`, either:

- Reuse the terminal for the next dependent task with `worker-start --terminal <handle> --task <next-task-id>`
- Release it with `orca orchestration worker-release --dispatch <dispatch-id> --json`

**Always close or release the delegated agent terminal once you have verified the task is complete.**
Leaving Claude Code (or any worker TUI) running consumes the agent slot and can block new dispatches or make the worktree appear busy. Verify the task before releasing the terminal:

- The branch has commits ahead of base: `git rev-list --count <base-branch>..<branch>` must be > 0.
- The code compiles and relevant tests pass.
- The produced code matches the intended contract.

If `git rev-list` returns 0, the worker likely left the work uncommitted. Do not release; send a terminal nudge to commit, or commit the work yourself after reviewing it.

After releasing the terminal, perform worktree merge or cleanup:

### Validation gate

Do not dispatch `/review-gate` for every worktree by default. Classify the branch and choose the validation path:

| Risk   | Signals                                                                                                                                                  | Validation path                      | no-mistakes flags         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------- |
| High   | Shared contracts (paths matching `types\|schema\|interface\|model\|contract`), stacked PRs, auth/security changes, new dependencies, > 200 lines changed | Dispatch `/review-gate` per worktree | `--yes --skip ci`         |
| Medium | Feature work touching UI or API surface, smaller refactor                                                                                                | Dispatch `/review-gate` per worktree | `--yes --skip push,pr,ci` |
| Low    | Docs, tests, config tweaks, trivial fixes                                                                                                                | Local checks only                    | none                      |

**Local checks only** (run inside the worktree):

```bash
fallow audit --format json --quiet --explain --gate-marker agent
bun run lint
bun run format:check
bunx turbo run type-check
# run relevant unit tests
```

**Dispatch /review-gate**:

```bash
# Free the agent slot first
orca orchestration worker-release --dispatch <dispatch-id> --json

# Then dispatch a review task
orca orchestration worker-start \
  --worktree branch:<branch-name> \
  --agent claude \
  --task <review-task-id> \
  --run <run-id> \
  --json
```

Task spec example:

> Run `/review-gate` on branch `<branch-name>`. Intent: "Review this branch for correctness, test coverage, and merge contract compliance. Use `--skip push,pr,ci`. Write findings to `.agents/docs/qa/<area>-<branch-name>.md` via `/agents-docs`."

`/review-gate` runs `no-mistakes axi run` on the branch, captures findings, and writes them directly into a `qa/` dossier in `.agents/docs/qa/` via `/agents-docs`. There is no local `.review-gate/` report.

### Merge or cleanup

```bash
# Option A: Standard automated merge (runs pre-merge test hooks, squashes WIP commits, rebases onto target for linear history, and auto-removes worktree)
wt merge <target-branch>

# Option B: Explicit worktree cleanup & background process reaping for unmerged/abandoned branches
wt remove <branch-name> --reap

# Force-delete unmerged branch and dirty worktree if needed
wt remove <branch-name> -f -D
```

Prefer `worker-release` over `terminal close` when the task completed normally; it cleanly detaches the dispatch so Orca can account for the terminal. Use `wt remove <branch-name> --reap` to ensure orphan background processes (dev servers, watchers) are terminated when deleting a worktree.

## Sandbox note: linked worktrees are preferred

In a nono sandbox, linked worktree agents need the `@git:common-dir` grant to read the main repo's `.git`, or git fails with "not a git repository".
See [Sandbox setup for linked worktrees](REFERENCE.md#sandbox-setup-for-linked-worktrees) for the profile JSON, the verify command, and the top-level fallback.

## Troubleshooting

### "selector_not_found" when dispatching to a branch worktree

`--worktree branch:<branch-name>` only works if Orca already knows about that worktree. Create it first with worktrunk:

```bash
wt switch --create <branch-name> --base <base-branch> --no-cd
```

Then dispatch. Do not skip the creation step.

### Worker starts but Claude seems stuck

The dispatch can succeed while Claude is retrying an API call. Watch the terminal preview or poll the Run mailbox:

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

If you see "Waiting for API response", the worker is still alive. Give it time or inspect the terminal with `orca terminal read`.

### Worker shows the dispatch text but never starts the task

Symptom: the terminal preview shows the task/preamble text sitting in Claude's input line, and `worker-show` reports no progress, so the task never starts.
Cause: `worker-start` submits the prompt with a single delayed Enter write that is neither verified nor retried.
Events that can eat it: the `tui-idle` gate firing before Claude's prompt is live (common when several agents boot at once), a first-run trust/onboarding screen in a fresh worktree, or a transient `terminal_not_writable`.
Fix: wait for `tui-idle`, confirm the preview, then push the Enter (see section 5.5):

```bash
orca terminal wait --terminal <terminal-handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <terminal-handle> --text "" --enter --json
```

### `terminal_handle_stale` when dispatching

A leftover terminal from a previous session or failed dispatch is still attached to the worktree.
Orca refuses to reuse it.

Find and close the stale terminal, then reset and redispatch the task:

```bash
orca terminal list --worktree branch:<branch-name> --json
orca terminal close --terminal <terminal-handle> --json
orca orchestration task-update --id <task-id> --status ready --json
orca orchestration worker-start --worktree branch:<branch-name> --agent claude --task <task-id> --run <run-id> --json
```

### `worker-release` returns `state: retained, reason: user_takeover`

This happens when you have interacted with the worker terminal (e.g., reading output is sometimes enough). It is expected. Remove the worktree manually once you have verified the result:

```bash
wt remove <branch-name> --reap
```

### Worker completed but the terminal still looks active / no `worker_done` seen

If you (or a script) viewed or closed the worker terminal pane, Orca may retain the terminal with reason `user_takeover`. In that state the terminal observation can still show `running` and the pane title may look active even though the worker has already finished and sent `worker_done`.

**Do not trust terminal state alone.** Verify completion through the dispatch and run mailbox:

```bash
# 1. Check dispatch-level state
orca orchestration worker-show --dispatch <dispatch-id> --json
#   dispatch.status == "completed" AND worker.state == "succeeded" -> task is done.

# 2. Poll the run mailbox explicitly to retrieve the worker_done message
orca orchestration check --types worker_done,escalation,question --json
#   The message may have replayed: true if it was already delivered once.

# 3. Acknowledge the delivery so it stops replaying
orca orchestration check --ack <delivery-id> --json

# 4. Release the retained terminal resource promptly
orca orchestration worker-release --dispatch <dispatch-id> --json
```

If `worker-show` shows `succeeded` but `check` returns no message, the delivery may already be acknowledged or the worker may have failed to send `worker_done`. In the latter case, nudge the worker with a terminal message (see the section above on "preview says please proceed").

**Release terminals promptly.** If a completed worker stays attached too long, Orca revokes the dispatch capability and any late `worker_done` retry is rejected with `dispatch_capability_invalid`. Release (or close) the terminal as soon as you have acknowledged the delivery.

## Recovery

- Stop a stuck worker: `orca orchestration worker-stop --dispatch <dispatch-id> --json`
- Inspect a worker: `orca orchestration worker-show --dispatch <id> --json`
- Read worker output: `orca orchestration worker-read --dispatch <id> --limit 50 --json`
- Reply to a worker question: `orca orchestration reply --id <msg-id> --body "..." --json`
- Retry a failed worker after inspecting `worker-show`: `worker-start --retry-of <id>`

## Lessons learned

- **Direct `wt switch --create <branch> --base <base> --no-cd`** creates worktrees cleanly and runs pre-start/post-start project hooks.
- **Pre-approve project hooks via `wt config approvals add --yes`** so non-interactive agent runs execute hooks without hitting approval prompts.
- `**wt merge <target>` provides an automated 1-command pipeline**: runs pre-merge test hooks, squashes WIP commits, rebases onto target for a linear history, fast-forwards target ref, and auto-deletes the worktree.
- `**wt remove <branch> --reap**` explicitly removes worktrees and kills background dev servers or file watchers running under the worktree directory.
- `**wt remove --force <branch>**` is needed when the worktree has uncommitted changes the agent produced and discarded (e.g., temporary `.pi-*` files).
- **One-step `worker-start --worktree branch:<branch> --agent claude`** is cleaner than manually creating a terminal and dispatching later.
- `**orca orchestration worker-release --dispatch <id>**` automatically closes the agent terminal pane UI and archives transcript logs.
- `**worker-release` may return `state: retained, reason: user_takeover`** if you already edited the worktree manually. This is expected; just remove the worktree once you are done verifying.
- **Acknowledge completed deliveries (`check --ack <delivery_id>`)** to prevent duplicate event loops.
- **Check for stale terminals before dispatching**; a leftover terminal can cause `terminal_handle_stale` and block dependent tasks from starting.
- **Health-check dispatched workers every ~30 minutes**; dispatch-level state from `worker-show` is more reliable than the terminal pane title alone. A crashed worker may never send `worker_done`.
- **A connected, "running" terminal can still be idle at the Claude prompt**; if the preview says "please proceed" or the title is a static checkmark, nudge the worker to commit and call `worker_done`.
- **A dispatched worker can sit with the task text pasted but unsubmitted.** `worker-start` sends the prompt and then a separate Enter ~500ms later, with no verification or retry; the `tui-idle` gate can fire early under parallel boots. Verify each dispatch right after launch and nudge with `terminal send --text "" --enter` if the preview shows the text stuck at the prompt.
- **Stagger worker launches** when booting several agents at once, or gate each on the previous terminal reaching `tui-idle`, to make the lost-Enter race far less likely.
- **Do not trust `worker_done` blindly**: verify the branch compiles, tests pass, and the produced code matches the intended contract before merging. A worker can report success while emitting shapes that do not match the API or leaving stale enum references in tests.
- **Silent-stall has two modes.** Mode A: prompt text never reached Claude's working state because the delayed Enter was lost; `dispatch.status` stays `dispatched` and the terminal preview is a bare `❯`. Mode B: the worker is doing real work but never reports a heartbeat or progress; the terminal preview shows active tool calls but `dispatch.last_heartbeat_at` is `null`. Section 5.6 distinguishes them by terminal preview + `lastOutputAt`, never by `dispatch.last_heartbeat_at` (which is unreliable - always `null` in our runs).
- **The polling loop is event-driven, not time-driven.** `check --wait` returns only when a message arrives, so silent stalls stay invisible for the entire run. The fix is a time-driven waker (`scripts/waker.sh`) that walks `scripts/rules/*.sh` on a fixed cadence, plus a `submission gate` (section 5.5) run immediately after every `worker-start` to catch Mode A before the waker ever fires.
- **Keep monitoring rules append-only.** Each rule under `scripts/rules/` is a separate executable file with a `(RUN_ID) -> action JSON` contract. New failure modes get new rule files, never edits to the waker. This keeps the waker loop stable and makes rules individually testable.
- **Workers may call `worker_done` without ever committing.** The `filesModified` list in a `worker_done` payload is a report, not proof that the changes are on the branch. Always verify `git rev-list --count <base-branch>..<branch>` is greater than 0, or check `git status` in the worktree, before treating a task as done. Make `git add -A && git commit -m "..."` an explicit, required step in every dispatch prompt; without it, agents routinely skip the commit.
