# review-gate reference

Detailed commands, templates, and integration examples for `/review-gate`.

## Single-branch review

### 1. Ensure a feature branch exists

In the current worktree:

```bash
git checkout -b review/<topic>
# or use the existing feature branch
git status
```

For a parallel-friendly worktree instead, use `wt`:

```bash
wt switch --create review/<topic> --base <base> --no-cd
```

### 2. Run the gate

```bash
no-mistakes axi run \
  --intent "Review the auth module for race conditions, error handling gaps, and test coverage. Also inspect the surrounding user-service code even where it was not changed in this branch."
```

### Fast / cheap modes

`no-mistakes axi run` has no dedicated "fast" flag, but you can skip expensive steps:

| Goal                                                              | Command                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| Default unattended review; push and open PR but do not monitor CI | `no-mistakes axi run --intent "..." --yes --skip ci`         |
| Review-only; no push, no PR, no CI; fastest safe mode             | `no-mistakes axi run --intent "..." --yes --skip push,pr,ci` |
| Full pipeline including CI monitor (only when shipping in one go) | `no-mistakes axi run --intent "..." --yes`                   |

Always use `--yes` for agent-driven runs so approval gates auto-resolve and actionable findings move into `review: fixing`.

### 3. Drive gates

`no-mistakes axi respond` can block while the pipeline agent edits and re-reviews. Run it through `bg_run` so the durable notification wakes you instead of tying up the turn.

```bash
# approve the step as-is
bg_run --name "nm-approve-review" -- \
  no-mistakes axi respond --action approve

# fix specific auto-fix findings
bg_run --name "nm-fix-findings" -- \
  no-mistakes axi respond --action fix --findings r1,r2

# skip the step
bg_run --name "nm-skip-step" -- \
  no-mistakes axi respond --action skip
```

Then wait for the `<background-task-notification>` and read `bg_logs` once if you need the gate output.

### 4. Write the QA dossier

Path: `.agents/docs/qa/<title>.md`

Use `/agents-docs` to create the dossier so frontmatter and index stay consistent:

```bash
bun .agents/skills/agents-docs/scripts/docs.js new qa "<title>" --area <area>
```

Then paste the findings into the dossier body:

```markdown
# Review findings: <branch>

## Scope

- Branch: `<branch>`
- Base: `<base>`
- Intent: `<intent>`

## Outcome

- no-mistakes outcome: `<checks-passed | passed | failed | cancelled>`

## Summary

- Auto-fix findings: N
- Ask-user findings: M
- Skipped findings: K

## Ask-user findings (verbatim)

<paste each finding here>

## Next actions

- <action 1>
- <action 2>
```

Set the dossier frontmatter `type: coverage`.
For multi-PR merge batches, add `merge_batch: <slug>` so the contributing dossiers group together.
Use `status: pending` for the initial write, then flip to `active` once the verdict is recorded.
Regenerate the index:

```bash
bun .agents/skills/agents-docs/scripts/docs.js index
```

## Standalone parallel review fallback

Use only when `/worktrunk-orca-delegation` is not active.

### 1. Create worktrees

```bash
wt switch --create review-auth --base dev --no-cd
wt switch --create review-billing --base dev --no-cd
wt switch --create review-search --base dev --no-cd
```

### 2. Start a review in each worktree

```bash
orca orchestration worker-start \
  --worktree branch:review-auth \
  --agent claude \
  --task <task-id> \
  --run <run-id> \
  --json
```

Task spec example:

> Run /review-gate on branch `review-auth`.
> Intent: "Review the auth module for race conditions, error handling gaps, and test coverage."
> Write findings to a `qa/` dossier in `.agents/docs/qa/` via `/agents-docs` (dossier title: `<area>: review-auth`).

### 3. Poll each run to outcome

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

### 4. Collect findings

After all runs finish, link each contributing QA dossier under a single `merge_batch` slug in the corpus.
No master local report is needed - the dossiers are the source of truth.

## Integration with /agents-docs

After each per-branch run finishes, create or update its QA dossier:

```bash
bun .agents/skills/agents-docs/scripts/docs.js new qa "<title>" --area <area>
```

Then:

1. Paste the findings into the dossier body.
2. Update the dossier frontmatter `type: coverage`. For multi-PR merge batches, add `merge_batch: <slug>` on every contributing dossier.
3. Regenerate the index:
    ```bash
    bun .agents/skills/agents-docs/scripts/docs.js index
    ```

## Waiting on long-running no-mistakes commands

Use `bg_run` for anything that may take more than a few seconds. Do not poll with `ps`, repeated `no-mistakes axi status`, or `bg_status` loops.

Example status poll that respects the notification boundary:

```bash
bg_run --name "nm-status-check" --timeout 600 -- \
  bash -c "sleep 180 && no-mistakes axi status 2>&1 | tail -100"
```

When the `<background-task-notification>` arrives, read the output once:

```bash
bg_logs <task-id> --tail --max-bytes 30000
```

If the run is still at a `gate:`, respond with another `bg_run`. Repeat until the output shows an `outcome:`.

If a synchronous `no-mistakes axi respond` command times out, do not assume it failed. Check the run status with `bg_run` before sending another response; the daemon may already be applying the previous request.

## Integration with /worktrunk-orca-delegation

When `/worktrunk-orca-delegation` dispatches a pre-merge validation task, the task spec should be:

> Run `/review-gate` on branch `<branch>`.
> Intent: "Verify this branch against the merge contract: <contract>.
> Write findings to a `qa/` dossier in `.agents/docs/qa/` via `/agents-docs` (dossier title: `<area>: <branch>`) and report the no-mistakes outcome."

`/review-gate` does not create the worktree or manage parallel dispatch in this mode.
