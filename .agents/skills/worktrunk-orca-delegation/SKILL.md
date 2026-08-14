---
name: worktrunk-orca-delegation
description: Delegate parallel coding tasks across `worktrunk` worktrees using Orca orchestration. Use when spawning multi-agent worktrees, dispatching workers, polling for completion, or gating merged results with `/review-gate`.
---

# Worktrunk + Orca delegation

Coordinate multiple agents across `worktrunk` worktrees using `orca` orchestration.

> **Use `orca`, not `orca-ide`.** All commands use the `orca` CLI.

## Quick start

1. `orca status --json`
2. `wt config approvals add --yes`
3. `orca orchestration run-create --objective "..." --json`
4. `orca orchestration task-create --run <run-id> --spec "..." [--deps '[...]'] --json`
5. `wt switch --create <branch> --base <base> --no-cd`
6. `orca orchestration worker-start --worktree branch:<branch> --agent claude --task <task-id> --run <run-id> --json`
7. Verify submission: `orca terminal wait --for tui-idle`, `orca terminal show`; nudge with `terminal send --text "" --enter` if stuck.
8. Poll: `orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json`
9. Verify commits: `git rev-list --count <base>..<branch>` > 0.
10. Validation gate: classify each worktree risk; route independent branches to per-worktree review and dependent/shared-contract branches to a single merge-preview review. **Do not release or merge until the branch is review-clear.**
11. Release: `orca orchestration worker-release --dispatch <id> --json`
12. Merge/cleanup: `wt merge <target>` or `wt remove <branch> --reap`.

## Workflow

### 1. Plan splits

Group work so each worktree has a narrow, reviewable scope. Only independent worktrees run in parallel.

### 2. Create run and tasks

```bash
orca orchestration run-create --objective "<objective>" --json
orca orchestration task-create --run <run-id> --spec "<scope>" [--deps '["<task-id>"]'] --json
```

### 3. Create worktrees

```bash
wt switch --create <branch> --base <base> --no-cd
```

Prime fresh worktrees once to skip first-run screens. See [REFERENCE.md](REFERENCE.md).

**Agent skills must be present in the worktree.** After merging the source branches, overlay any skills that exist in the orchestrator's worktree but are missing in the new worktree. Use `--ignore-existing` so branch-specific skill edits are never overwritten.

```bash
if [ -d <source-worktree>/.agents/skills ]; then
  mkdir -p <worktree>/.agents/skills
  rsync -au --ignore-existing <source-worktree>/.agents/skills/ <worktree>/.agents/skills/
fi
if [ -d <source-worktree>/.claude/skills ]; then
  mkdir -p <worktree>/.claude/skills
  rsync -au --ignore-existing <source-worktree>/.claude/skills/ <worktree>/.claude/skills/
fi
```

`<source-worktree>` is the orchestrator's own worktree (usually the current one); `<worktree>` is the new disposable worktree.

Do not use a Worktrunk `post-start` hook for this: hooks run before source-branch merges, so the synced files become untracked and block `git merge`. Sync after the merges instead.

### 4. Dispatch workers

```bash
orca orchestration worker-start \
  --worktree branch:<branch> \
  --agent claude --task <task-id> --run <run-id> \
  [--model haiku|sonnet|opus] --json
```

Stagger launches to avoid lost-Enter races. See [REFERENCE.md](REFERENCE.md).

### 5. Verify submission

After every `worker-start`, wait for `tui-idle`, inspect the preview, and send a bare Enter if the prompt text is still stuck. See [REFERENCE.md](REFERENCE.md).

**Pre-flight the dispatcher before a full run:**

```bash
orca status --json
claude --model haiku -p "this is a test"
```

If `orca status` is not `ready` or the headless model test fails, stop and fix the dispatcher before dispatching workers.

### 6. Poll and recover

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

Health-check stalled workers every ~30 min with `worker-show` and terminal preview. See [REFERENCE.md](REFERENCE.md).

### 7. Commit gate

Before `worker_done`, the worker must commit. Verify with:

```bash
git rev-list --count <base>..<branch>
```

### Review-clear

A branch is **review-clear** when it has either:

- passed `/review-gate` (medium/high risk, new dependencies, shared contracts, auth/security, or large diffs), or
- passed local checks only and is explicitly classified as **low-risk** (docs, tests, config tweaks, trivial fixes).

**Do not `wt merge` a worker branch until it is review-clear.**

If a branch was already merged without review, make it review-clear retroactively by running `/review-gate` on the integration branch before any further merges.

### 8. Validation gate

Before releasing, classify the worktree risk and choose the validation path.
**Default to a disposable merge-preview worktree; use per-worktree review only when the branch is provably independent and low-risk.**

| Risk   | Signals                                                                     | Path                                                                        |
| ------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| High   | Shared contracts, stacked PRs, auth/security, new dependencies, large diffs | Disposable merge-preview worktree + `/review-gate`                          |
| Medium | Feature work with UI/API surface changes, provider/registry changes         | Disposable merge-preview worktree + `/review-gate` with `--skip push,pr,ci` |
| Low    | Docs, tests, config tweaks, trivial fixes, provably independent branches    | Per-worktree `/review-gate` or local checks only                            |

A branch is **provably independent** when its worktree doc has no `depends on` field and its changed files do not overlap with any other active worktree.

**Local checks only:**

```bash
fallow audit --format json --quiet --explain --gate-marker agent
bun run lint
bun run format:check
bunx turbo run type-check
# run relevant unit tests
```

**Dispatch /review-gate:**

```bash
orca orchestration worker-start \
  --worktree branch:<branch> \
  --agent claude \
  --task <review-task-id> \
  --run <run-id> \
  --json
```

Task spec: "Run `/review-gate` on branch `<branch>` with intent ... and write findings to `.agents/docs/qa/` via `/agents-docs`."

### Multi-worktree validation routing

When orchestrating several worktrees, default to a single disposable merge-preview worktree. Route to per-worktree review only when every branch is provably independent and low-risk.

| Worktree relationship | Signals | Validation path |
| --- | --- | --- |
| Default (when in doubt) | Any medium/high risk, new dependencies, shared contracts, or overlapping files | Disposable merge-preview worktree + `/review-gate` |
| Independent and low-risk branches only | Each worktree doc has no `depends on` and file lists do not overlap | Per-worktree `/review-gate` or local checks |

To detect dependencies, read the worktree docs' `depends on` field. If a worktree depends on another active branch, do not dispatch per-worktree `/review-gate` until its dependency is merged; instead create a single merge-preview task that merges both branches in order and runs `/review-gate`.

#### Example: merge-preview review task

Create a disposable QA worktree from the integration base:

```bash
wt switch --create qa/vp-merge --base <base-branch> --no-hooks --no-cd
QA_PATH=$(wt list --format=json | jq -r '.items[] | select(.branch == "qa/vp-merge") | .worktree.path')
```

Merge branches in dependency order:

```bash
git -C "$QA_PATH" merge --no-ff <dependency-branch>
git -C "$QA_PATH" merge --no-ff <dependent-branch>
```

Run local verification:

```bash
cd "$QA_PATH"
npm test
npx tsc --noEmit
```

Dispatch `/review-gate` on the combined state:

```bash
orca orchestration task-create \
  --run <run-id> \
  --spec "Run /review-gate on merge-preview branch qa/vp-merge. Intent: Review combined integration of <dependency-branch> and <dependent-branch>. Use --skip push,pr,ci. Write findings to .agents/docs/qa/<area>-vp-merge.md via /agents-docs." \
  --json

orca orchestration worker-start \
  --worktree branch:qa/vp-merge \
  --agent claude \
  --task <review-task-id> \
  --run <run-id> \
  --json
```

Remove the QA worktree after the dossier is written.

### Manual `worker_done`

If a worker finished but its `worker_done` was lost (terminal closed, run unbound, or capability revoked), manually complete the task:

```bash
orca orchestration send \
  --type worker_done \
  --outcome succeeded \
  --task-id <task-id> \
  --dispatch-id <dispatch-id> \
  --subject "Manual worker_done" \
  --body "Completed task <task-id> for branch <branch-name>." \
  --run <run-id>
```

Verify completion with:

```bash
orca orchestration check --types worker_done --json
orca orchestration task-list --run <run-id> --json
```

Use this only after confirming the branch has commits, tests pass, and the work is actually done.

### 9. Release and merge

```bash
# 1. Confirm the branch is review-clear.
# 2. Release the worker terminal.
# 3. Merge into the target branch.
orca orchestration worker-release --dispatch <id> --json
wt merge <target>
```

## Rules

- Always use `orca`, not `orca-ide`.
- Stagger worker launches; gate on `tui-idle`.
- Verify submission after every `worker-start`.
- Verify commits exist before releasing.
- Close stale terminals before redispatch.
- Use a time-driven waker for silent stalls. See [REFERENCE.md](REFERENCE.md).
- `/review-gate` is dispatched conditionally per worktree; low-risk worktrees run local checks only. When in doubt, dispatch `/review-gate` - never merge a branch that is not review-clear.
- Check the worker runtime for sandbox restrictions. Delegated agents that need local state persistence or browser access may fail with `EACCES` inside locked-down sandboxes (e.g., nono). Move the worktree to a host with full read/write permissions before dispatching visual QA or long-running interactive tasks.
- If a worker fails to initialize (auth error, model timeout, or stuck at `Combobulating…`/`Blanching…`), retry once with a different model (e.g., `haiku` instead of the default). If it still fails, stop and report the exact blocker.
- Use repo-local worktrees when running inside a sandbox. Configure Worktrunk with `worktree-path = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"` and add `.worktrees/` to `.gitignore`. This keeps worktrees under `$WORKDIR`, avoiding the need to grant broad `$HOME` read access just so tools can resolve paths.
- Verify that the build/test tools can actually access the worktree. Bun may fail with `CouldntReadCurrentDirectory`/`AccessDenied` when the sandbox blocks the worktree path or when `bun run` calls `openat` on ancestor directories (`/home`, `/`). Workaround: invoke the underlying tool directly, e.g., `node node_modules/.bin/jest` instead of `bun run test`.
- On such hosts run checks in the main checkout, use repo-local worktrees, or restart the agent session after moving worktrees so the sandbox rules are applied to the new paths.

## Troubleshooting

See [REFERENCE.md](REFERENCE.md).

## See also

- [REFERENCE.md](REFERENCE.md) - detailed commands, waker script, silent-stall decision table, sandbox setup, lessons learned.
