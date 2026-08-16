---
name: worktrunk-orca-delegation
description: Delegate parallel coding tasks across `worktrunk` worktrees using Orca orchestration. Use when spawning multi-agent worktrees, dispatching workers, polling for completion, or gating merged results with `/review-gate`.
---

# Worktrunk + Orca delegation

Coordinate multiple agents across [`worktrunk`](https://github.com/max-sixty/worktrunk) (`wt`) worktrees using [`orca`](https://github.com/stablyai/orca) orchestration.

> **Use `orca`, not `orca-ide`.**
> All commands use the [`orca`](https://github.com/stablyai/orca) CLI.
> Worktree operations use [`worktrunk`](https://github.com/max-sixty/worktrunk) (`wt`).

## Quick start

1. `orca status --json`
2. `wt config approvals add --yes`
3. `orca orchestration run-create --objective "..." --json`
4. `orca orchestration task-create --run <run-id> --spec "..." [--deps '[...]'] --json`
5. `wt switch --create <branch> --base <base> --no-cd`
6. `orca orchestration worker-start --worktree branch:<branch> --agent claude --task <task-id> --run <run-id> --json`
7. Verify submission: `orca terminal wait --for tui-idle`, `orca terminal show`; nudge with `terminal send --text "" --enter` if stuck.
8. Supervise / Poll: launch background waker in Orca (`orca terminal create --title "waker" --command ".agents/skills/worktrunk-orca-delegation/scripts/waker.sh --run <run-id> --max-ticks 12" --json`) or run `orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json`.
9. Verify commits: `git rev-list --count <base>..<branch>` > 0.
10. Validation gate: classify each worktree risk; route independent branches to per-worktree review and dependent/shared-contract branches to a single merge-preview review. **Do not release or merge until the branch is review-clear.**
11. Release: `orca orchestration worker-release --dispatch <id> --json`
12. Merge/cleanup: `wt merge <target>` or `wt remove <branch> --reap`.

## Workflow

### 1. Plan splits & dispatch lifecycle

Group work so each worktree has a narrow, reviewable scope. Only independent worktrees run in parallel.

> **Worktree Dispatch Contract:**
> 1. `agents-docs` plans the feature and runs `scaffold-worktrees` to generate flight logs (`worktrees/<area>-<slug>.md`).
> 2. Each flight log specifies the task scope, branch name, and dependencies for `worktrunk-orca-delegation`.
> 3. The orchestrator updates the flight log status (`active` &rarr; `merged`) as workers complete, and dispatches `/review-gate` before release.

### 2. Create run and tasks

```bash
orca orchestration run-create --objective "<objective>" --json
orca orchestration task-create --run <run-id> --spec "<scope>" [--deps '["<task-id>"]'] --json
```

### 2b. Commit agents-docs to the default branch

Worker agents run in linked git worktrees that share the repository history but start from the committed state of their base branch. Any `.agents/docs/` plans, worktrees, or decisions created in the orchestrator's checkout must be committed to the default branch (usually `main`) **before** creating worktrees. Otherwise workers will see stale or missing docs and fall back to searching the source directly.

```bash
# Commit planning docs and flight logs so worktrees inherit them.
git add .agents/docs/
git commit -m "docs(agents): sync execution plans and worktree flight logs"
```

If you must keep docs on a feature branch, merge that branch into the default branch first, or rebase every worktree branch onto the docs commit.

### 3. Create worktrees

```bash
wt switch --create <branch> --base <base> --no-cd
```

Prime fresh worktrees once to skip first-run screens. See [REFERENCE.md](REFERENCE.md).

**Overlay skills into the worktree:** After creating the worktree, copy over any orchestrator skills with `--ignore-existing`:

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

For hook execution order and sandbox setup details, see [REFERENCE.md](REFERENCE.md).

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

Run the bundled waker script in a managed Orca terminal pane to monitor health and automatically unstick workers across ticks:

```bash
orca terminal create \
  --title "waker for <run-id>" \
  --command ".agents/skills/worktrunk-orca-delegation/scripts/waker.sh --run <run-id> --max-ticks 12" \
  --json
```

Or hold the coordinator turn with Orca's native event-driven message wait:

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

Health-check stalled workers manually or via `waker.sh --single-tick` if needed.
See [REFERENCE.md](REFERENCE.md).

### 7. Commit gate

Before `worker_done`, the worker must commit. Verify with:

```bash
git rev-list --count <base>..<branch>
```

### Review-clear & merge

A branch is **review-clear** when it has either:

- passed `/review-gate` (medium/high risk, new dependencies, shared contracts, auth/security, or large diffs), or
- passed local checks only and is explicitly classified as **low-risk** (docs, tests, config tweaks, trivial fixes).

**Do not merge a worker branch until it is review-clear.**

Once review-clear, integrate the branch using:

```bash
wt merge <target-branch>
```

`wt merge` runs configured pre-merge hooks and handles branch integration.
Use `git merge --no-ff <branch>` only as a fallback for raw git checkouts.

If a branch was already merged without review, make it review-clear retroactively by running `/review-gate` on the integration branch before any further merges.

### 8. Validation gate & multi-worktree routing

Before releasing, classify worktree risk and route to the appropriate validation path.
**Default to a disposable merge-preview QA worktree; use per-worktree review only when branches are provably independent and low-risk.**

| Risk / Relationship | Signals | Validation Path |
|---|---|---|
| **High / Medium Risk** | Shared contracts, stacked PRs, auth/security, new dependencies, large diffs | Disposable merge-preview QA worktree + `/review-gate` |
| **Dependent / Stacked** | Worktree doc has `depends on` or files overlap | Disposable merge-preview QA worktree + `/review-gate` |
| **Low Risk & Independent** | Docs, tests, config tweaks, no `depends on`, disjoint files | Per-worktree `/review-gate` or local checks |

A branch is **provably independent** when its worktree doc has no `depends on` and its changed files do not overlap with any other active branch.

**Local checks only:**

```bash
fallow audit --format json --quiet --explain --gate-marker agent
bun run lint
bun run format:check
bunx turbo run type-check
```

**Dispatching `/review-gate`:**

- **Independent branch:** dispatch a task running `/review-gate` directly in the branch worktree.
- **Combined / Stacked branches:** create a single disposable merge-preview QA worktree following [`/review-gate` Step 10](file:///home/tys203831/Documents/Coding/vision-proxy/.agents/skills/review-gate/SKILL.md#L229), run `/review-gate`, and write findings to `.agents/docs/qa/`.

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

### 9. Working with stacked / dependent worktrees

When a feature set consists of stacked or interdependent branches (such as database migrations, core API refactors, and UI adapters), follow the stacked worktree protocol:

1. **Layer Sequencing & Branch Naming:**
   Name branches sequentially to indicate dependency order (e.g. `stack-01-core-schema`, `stack-02-api-endpoints`, `stack-03-ui-client`).
2. **Flight Log Declarations:**
   Declare dependencies in each worktree's flight log (`.agents/docs/worktrees/<area>-<slug>.md`):
   ```yaml
   depends_on: [../worktrees/backend-schema.md]
   stack_position: 2
   stack_batch: 2026-02-auth-overhaul
   ```
3. **Integration Merge-Preview:**
   Never merge stacked branches directly into `main` without testing the full stack together.
   Create a single disposable merge-preview worktree (`qa/<stack-batch>`) following [`/review-gate` Step 10](file:///home/tys203831/Documents/Coding/vision-proxy/.agents/skills/review-gate/SKILL.md#L200), merge layers in order (`stack-01` &rarr; `stack-02` &rarr; `stack-03`), and run the full test suite.
4. **Bottom-Up Merge Order:**
   Always land the bottom-most layer into the target default branch first.
   Once `stack-01` lands, rebase or pull `main` into `stack-02` to resolve any conflicts before landing `stack-02`.
5. **Post-Merge Layer Checklist:**
   After each layer merges:
   - Update its flight log status to `merged`.
   - Update downstream flight logs to mark the dependency satisfied.
   - Retarget / rebase remaining active worktrees against the updated target branch.

### 10. Release and merge

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
- **Single-Preview Worktree Invariant (`qa/<batch-slug>`):** Use the `qa/<batch-slug>` format for integration worktrees (e.g. `qa/vp-post-migration-merge`). Do NOT hardcode literal names. Maintain exactly one preview worktree per integration batch. When base updates arrive, pull them into the existing preview worktree via `git merge <base>`. Upon final merge, immediately prune the preview worktree (`wt remove qa/<batch-slug>`).
- **Commit Provenance Verification:** Always run `git log -n 5 --format='%h | %an <%ae> | %cr | %s'` to ground author attribution before forming hypotheses about external agent activity on a branch.
- Check the worker runtime for sandbox restrictions. Delegated agents that need local state persistence or browser access may fail with `EACCES` inside locked-down sandboxes (e.g., nono). Move the worktree to a host with full read/write permissions before dispatching visual QA or long-running interactive tasks.
- If a worker fails to initialize (auth error, model timeout, or stuck at `Combobulating…`/`Blanching…`), retry once with a different model (e.g., `haiku` instead of the default). If it still fails, stop and report the exact blocker.
- Use repo-local worktrees when running inside a sandbox. Configure Worktrunk with `worktree-path = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"` and add `.worktrees/` to `.gitignore`. This keeps worktrees under `$WORKDIR`, avoiding the need to grant broad `$HOME` read access just so tools can resolve paths.
- Verify that the build/test tools can actually access the worktree. Bun may fail with `CouldntReadCurrentDirectory`/`AccessDenied` when the sandbox blocks the worktree path or when `bun run` calls `openat` on ancestor directories (`/home`, `/`). Workaround: invoke the underlying tool directly, e.g., `node node_modules/.bin/jest` instead of `bun run test`.
- On such hosts run checks in the main checkout, use repo-local worktrees, or restart the agent session after moving worktrees so the sandbox rules are applied to the new paths.

## Troubleshooting

See [REFERENCE.md](REFERENCE.md).

## See also

- [REFERENCE.md](REFERENCE.md) - detailed commands, waker script, silent-stall decision table, sandbox setup, lessons learned.
