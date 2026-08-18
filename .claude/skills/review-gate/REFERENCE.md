# review-gate reference

Detailed commands, templates, and integration examples for `/review-gate` powered by [`no-mistakes`](https://github.com/kunchenguid/no-mistakes).

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

`no-mistakes axi respond` can block while the pipeline agent edits and re-reviews.
Run it asynchronously through your agent harness or dedicated terminal so the completion signal wakes you instead of tying up the turn.

```bash
# approve the step as-is
no-mistakes axi respond --action approve

# fix specific auto-fix findings
no-mistakes axi respond --action fix --findings r1,r2

# skip the step
no-mistakes axi respond --action skip
```

Or run unattended via the bundled polling wrapper: `AUTO_APPROVE_ASK_USER=1 bash scripts/poll-no-mistakes.sh 30`.

### 4. Write the QA dossier

Path: `.agents/docs/qa/<title>.md`

Use `/agents-docs` to create the dossier so frontmatter and index stay consistent:

```bash
bun .agents/skills/agents-docs/scripts/docs.js new coverage "<title>" --area <area>
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

## Auto-Fixed Findings

| Finding ID | Rule / Concern | Fix Applied | Commit Hash |
|---|---|---|---|
| `<id>` | `<rule>` | `<fix description>` | `<hash>` |

## Resolution Intent

- Ask-user findings resolved: `<rationale of choices taken>`
- Pre-existing codebase bugs filed: `bugs/<area>-<slug>.md`

## Next actions

- <action 1>
- <action 2>

## PR strategy

- Recommendation: `combined` or `individual`
- Rationale: `<why this choice fits the reviewed branches>`
- Merge order (if individual):
  - `<branch-1>`
  - `<branch-2>`
- Auto-fix commits to port (if individual):
  - `<hash>` `<description>`
- Next action: `<open PRs / cherry-pick fixes / rebase>`
```

Set the dossier frontmatter `type: coverage`.
For multi-PR merge batches, add `merge_batch: <slug>` so the contributing dossiers group together.
Use `status: pending` for the initial write, then flip to `active` once the verdict is recorded.
Regenerate the index:

```bash
bun .agents/skills/agents-docs/scripts/docs.js index
```

## Choosing a shipping strategy

### Detect shared files across branches

```bash
for b in <branch-1> <branch-2> ...; do
  echo "=== $b ==="
  git diff --name-only <base>.."$b"
done
```

### Check clean merges

```bash
git merge-tree --write-tree <base> <branch>
```

A printed tree hash means the branch merges cleanly with the base.
A non-empty conflict diff means the branches are coupled and should probably ship together.

### Recommend combined PR

Use when:
- branches touch the same files,
- branches declare `depends_on` on each other, or
- the gate was run on a merge-preview worktree because the combined state is the only honest review target.

### Recommend individual PRs

Use when:
- branches are semantically independent,
- no shared files exist, and
- the user wants smaller reviews and cleaner revert history.

Suggested merge order:
1. bug fixes and security patches,
2. behavior changes that others may depend on,
3. larger features.

### Port auto-fix commits

When `no-mistakes` applies fixes on a disposable preview branch, find them with:

```bash
git log --oneline <base>..qa/<batch-slug>
```

Then cherry-pick onto the owning feature branch:

```bash
git -C <feature-worktree> cherry-pick <fix-hash>
```

## Daemon polling & JSON-RPC socket architecture

The `poll-no-mistakes.sh` script monitors active runs by communicating directly with the daemon:

1. **Repo lookup:** Resolves main repo root via `git rev-parse --git-common-dir` and reads `repo_id` from `~/.no-mistakes/state.sqlite`.
2. **Socket RPC:** Sends `get_active_run` over Unix domain socket `~/.no-mistakes/socket` via JSON-RPC.
3. **State evaluation:**
   - Prints `RUNNING` while active.
   - When `run.awaiting_agent` is true, parses findings list.
   - Auto-fixes `action: auto-fix` finding IDs via socket command.
   - Halts on `action: ask-user` findings unless `AUTO_APPROVE_ASK_USER=1` is exported.
   - Prints `FINISHED` when the run completes with an outcome.

### Repo-level auto-fix configuration

To allow up to 3 rounds of automated review fixes without manual gate intervention:

```yaml
# .no-mistakes/config.yaml
auto_fix:
  review: 3
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
bun .agents/skills/agents-docs/scripts/docs.js new coverage "<title>" --area <area>
```

Then:

1. Paste the findings into the dossier body.
2. Update the dossier frontmatter `type: coverage`. For multi-PR merge batches, add `merge_batch: <slug>` on every contributing dossier.
3. Regenerate the index:
    ```bash
    bun .agents/skills/agents-docs/scripts/docs.js index
    ```

## Waiting on long-running no-mistakes commands

Execute commands asynchronously using your harness background runner, an Orca terminal pane (`orca terminal create`), or the bundled polling script `scripts/poll-no-mistakes.sh`.
Do not poll with `ps`, repeated `no-mistakes axi status`, or tight shell loops.

Example asynchronous status check:

```bash
# Check status once or inspect JSON status without blocking
no-mistakes axi status
```

If the run is still at a `gate:`, respond with the appropriate action.
Repeat until the output shows an `outcome:`.

If a synchronous `no-mistakes axi respond` command times out, do not assume it failed.
Check the run status with `no-mistakes axi status` before sending another response; the daemon may already be applying the previous request.

## Integration with /worktrunk-orca-delegation

When `/worktrunk-orca-delegation` dispatches a pre-merge validation task, the task spec should be:

> Run `/review-gate` on branch `<branch>`.
> Intent: "Verify this branch against the merge contract: <contract>.
> Write findings to a `qa/` dossier in `.agents/docs/qa/` via `/agents-docs` (dossier title: `<area>: <branch>`) and report the no-mistakes outcome."

`/review-gate` does not create the worktree or manage parallel dispatch in this mode.
