---
name: review-gate
description: Run a `no-mistakes axi run` review on a branch or codebase scope. Use when gating, reviewing, or pre-merge QA-ing a branch, worktree, or stacked PR.
user-invocable: false
---

# review-gate

Drive `no-mistakes axi run` for code-level review and pre-merge QA. Findings are captured in `.agents/docs/qa/` dossiers; parallel reviews delegate to `/worktrunk-orca-delegation`.

> **Docs first.**
> When `/agents-docs` is active, capture findings directly into a `.agents/docs/qa/` dossier.
> There is no local report step: the QA dossier is the single source of truth.

## Quick start

1. **Resolve scope.**
   Pick a branch and an intent that names what to review.
   For whole-codebase coverage, use a small branch diff plus an intent that lists the areas to inspect.
2. **Run the gate.**
    ```bash
    no-mistakes axi run --intent "Review <area>: check <concern A>, <concern B>, <concern C>"
    ```
3. **Drive the findings.**
   Approve, fix, or escalate `ask-user` findings as the pipeline surfaces them.
4. **Capture the result.**
   Create or update a QA dossier in `.agents/docs/qa/` through `/agents-docs`.

### Long-running reviews

`no-mistakes axi run` can take 20-60 minutes for a deep review.
Run it in the background so the agent is not blocked by a shell timeout:

```bash
bg_run \
  --command "cd <worktree> && no-mistakes axi run --intent '...' --yes --skip push,pr,ci" \
  --name "review-gate <branch>" \
  --isAgent false
```

Then continue with other work. The terminal notification resumes the agent when the run reaches an outcome.
A short `bash` timeout can kill the CLI while the daemon is still in `review: fixing`, leaving the run hard to monitor and resume.

### Polling wrapper for approval gates

Use the bundled polling script to watch a run and unblock parked gates.
It talks to the no-mistakes daemon over its Unix socket and reads JSON-RPC responses, so it is deterministic and not sensitive to CLI text-formatting changes.

```bash
bash .agents/skills/review-gate/scripts/poll-no-mistakes.sh [poll-interval-seconds]
```

Run it from inside the target worktree:

```bash
cd /path/to/qa-worktree
bash /path/to/.agents/skills/review-gate/scripts/poll-no-mistakes.sh 30
```

The script:

1. Resolves the main repo path from `git rev-parse --git-common-dir` (linked worktrees share one no-mistakes repo record).
2. Looks up the `repo_id` in `~/.no-mistakes/state.sqlite`.
3. Calls `get_active_run` over `~/.no-mistakes/socket` using JSON-RPC.
4. Prints `RUNNING` while active, `BLOCKED` when `run.awaiting_agent` is true, and `FINISHED` when the run reaches an outcome.

When blocked, it inspects each finding's `action`:

- `auto-fix` -> asks no-mistakes to fix the identified ids.
- `ask-user` -> prints the ids and exits, because these are intent-sensitive findings that should be reviewed.

To also auto-approve `ask-user` findings unattended, set `AUTO_APPROVE_ASK_USER=1`:

```bash
AUTO_APPROVE_ASK_USER=1 bash .agents/skills/review-gate/scripts/poll-no-mistakes.sh 30
```

For fully unattended behavior, also enable repo-level auto-fix:

```yaml
# .no-mistakes/config.yaml
auto_fix:
  review: 3
```

## Core workflow

### Resolve scope

A no-mistakes review inspects committed changes against a base.
To review existing code that is not part of a large diff, keep the branch diff small and make the `--intent` explicit about which files, modules, or risks to inspect.

| Situation                   | Branch                             | Intent                                                 |
| --------------------------- | ---------------------------------- | ------------------------------------------------------ |
| Current feature branch      | the feature branch                 | review the changes plus named surrounding code         |
| Named area of existing code | a small branch (or current branch) | list the files/modules and the specific risks to check |
| Pre-merge validation        | the worktree branch                | verify the branch against its merge contract           |

### Per-worktree review vs merge-preview

| Branch relationship | Prefer | Why |
| --- | --- | --- |
| Independent branches with no shared files | Per-worktree review | Each branch is reviewable on its own. |
| Dependent or stacked branches, or branches touching shared files | Disposable merge-preview worktree (Step 10) | The combined state is what ships; per-branch reviews can miss merge-order issues, duplicate configuration drift, or shared-contract conflicts. |

When using `/worktrunk-orca-delegation`, inspect the worktree doc's `depends on` field. If it lists another active worktree, dispatch a single merge-preview review task for the whole batch instead of separate per-worktree reviews.

#### Example: merge-preview for two dependent worktrees

```bash
# Create a disposable worktree from the integration base
wt switch --create qa/vp-merge --base configurable-analyze-image-limit --no-hooks --no-cd
QA_PATH=$(wt list --format=json | jq -r '.items[] | select(.branch == "qa/vp-merge") | .worktree.path')

# Merge branches in dependency order

git -C "$QA_PATH" merge --no-ff vp-cli-core
git -C "$QA_PATH" merge --no-ff vp-hook-shims

# Verify the combined state
cd "$QA_PATH"
npm test
npx tsc --noEmit

# Run the gate (review-only; do not publish) in the background
bg_run \
  --command "no-mistakes axi run --intent 'Review combined vision-proxy CLI migration: verify CLI core and hook shims integrate cleanly' --yes --skip push,pr,ci" \
  --name "review-gate vp-merge" \
  --isAgent false
```

Then follow Step 10 to write the QA dossier and remove the disposable worktree.

### When to run

`/review-gate` is expensive because it runs `no-mistakes axi run`. Use it conditionally:

| Risk   | Signals                                                                     | Mode                                                         |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| High   | Shared contracts, stacked PRs, auth/security, new dependencies, large diffs | `no-mistakes axi run --intent "..." --yes --skip ci`         |
| Medium | Feature work with UI/API surface changes                                    | `no-mistakes axi run --intent "..." --yes --skip push,pr,ci` |
| Low    | Docs, tests, config tweaks, trivial fixes                                   | Do not use `/review-gate`; run local checks instead          |

For low-risk changes, run `fallow audit`, lint, typecheck, and unit tests directly in the worktree.

### Single review

Run the gate on one branch and drive it to outcome:

```bash
no-mistakes axi run --intent "<what the user set out to accomplish>"
```

Loop on `gate:` objects with `no-mistakes axi respond` until the run reaches an `outcome:`.
For the exact commands and decision rules, see the user-level `/no-mistakes` skill or [REFERENCE.md](REFERENCE.md).

### Approval gates and unattended runs

Use `--yes` for agent-driven reviews so approval gates auto-accept and actionable findings move into `review: fixing`:

```bash
no-mistakes axi run --intent "..." --yes
```

However, the global no-mistakes config sets `auto_fix.review: 0` by default, so review findings that require a fix are parked for manual approval rather than silently self-fixed. `no-mistakes axi status` shows this as `awaiting_agent: parked` under a `gate:` block.

**Fully unattended runs:** enable repo-level review auto-fix by committing `.no-mistakes/config.yaml`:

```bash
mkdir -p .no-mistakes
cat > .no-mistakes/config.yaml <<'EOF'
auto_fix:
  review: 3
EOF
```

This lets the pipeline fix up to 3 rounds of review findings without manual approval. Commit and push the file so CI and delegated agents use the same behavior.

**Manual gate loop (when auto-fix is disabled):** poll `no-mistakes axi status` for a `gate:` block and respond:

```bash
# Detect a parked gate
no-mistakes axi status | grep -q "awaiting_agent: parked"

# Approve the current step and continue
no-mistakes axi respond --action approve

# Or ask the pipeline to fix specific findings by id
no-mistakes axi respond --action fix --findings id-a,id-b
```

The pipeline may commit auto-fixes, so the branch head changes. Inspect progress with `no-mistakes axi status`. If `branch_sync.state` is `pipeline_owned`, do not make local commits until the run reaches an outcome.

Read step logs with `no-mistakes axi logs --step <step>` (`intent`, `rebase`, `review`, `test`, `document`, `lint`, `push`, `pr`, `ci`).

### Controlling where the run stops

The `ci` step monitors GitHub checks until merge/close and can run indefinitely.

- **Default:** push and open PR, skip CI monitoring:
    ```bash
    no-mistakes axi run --intent "..." --yes --skip ci
    ```
- **Review-only:** stop after lint, do not publish:
    ```bash
    no-mistakes axi run --intent "..." --yes --skip push,pr,ci
    ```
- **Full pipeline:** let it reach `ci` only when validating, merging, and shipping in one go.

### Parallel review

- **Independent branches:** `/worktrunk-orca-delegation` dispatches one `/review-gate` validation task per worktree.
- **Dependent branches or shared-contract touch:** dispatch a single merge-preview review task that creates a disposable worktree, merges the branches in order, and runs `/review-gate` on the combined state (Step 10).
- **Standalone fallback:** create one worktree per branch, run `no-mistakes axi run` in each, poll to outcome, collect findings. See [REFERENCE.md](REFERENCE.md).

### Findings output

Write findings directly into `.agents/docs/qa/` via `/agents-docs`:

```bash
bun .agents/skills/agents-docs/scripts/docs.js new qa "<title>" [--area <area>]
```

Set `type: coverage` for single-branch reviews. The dossier is the source of truth; no intermediate report.

## Step 10: local merge-preview QA

A clean single-branch review is not the same as a clean combined merge.
When several PRs are queued for the same target, conflicts, ordering bugs, and shared-contract drift only show up once the branches are combined.
Step 10 reproduces the merge locally and gates the actual GitHub merge step behind a QA pass over that combined state.

### When to run

Run Step 10 when any of the following holds:

- **A. Parallel branches.** Two or more open PRs are queued for the same target branch.
- **B. Shared contract touch.** A PR modifies paths whose segments match `types|schema|interface|model|contract`, or paths in a repo-configured `shared-globs` list (if defined).
- **C. Stacked branch.** A PR explicitly says it depends on another open PR.
- **D. Base drift.** A PR's base branch is more than 50 commits behind the target default branch.
- **E. Conflict risk signal.** A `git merge-tree` dry-run between the PR and the latest base returns non-empty conflicts.
- **F. User opt-in.** The user mentions `merge-preview`, `preview the merge`, or `QA the merge` in conversation.

When none of A-F applies, skip Step 10. A clean single-branch review is enough.

### What to do

1. **Pick the merge batch.** Group the PRs that will land together. Each batch gets one `merge_batch` slug (e.g. `2026-01-inline-image-gen`).
2. **Detect the base branch dynamically.** Run `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`; fall back to `git symbolic-ref refs/remotes/origin/HEAD`. Never hardcode `main`.
3. **Create one disposable worktree** named `qa/<slug>`, branched from the dynamic base:

    ```bash
    wt switch --create qa/<slug> --base <base> --no-cd
    ```

    One worktree per batch - do not split a batch across multiple worktrees.

    Before merging, confirm the declared order respects any stacked-branch dependency. Run:

    ```bash
    git rev-list --first-parent --count <pr_top> ^<pr_bottom>
    git rev-list --count <pr_top> ^<pr_bottom>
    ```

    Equal counts with no merge commits in the diff = strict stack. Merge bottom-of-stack first. Otherwise declare order by dependency, not by PR number.

4. **Merge each PR branch into the QA worktree in declared order**, resolving conflicts as they appear:
    ```bash
    QA_PATH=$(wt list --format=json | jq -r --arg b "qa/<slug>" '.items[] | select(.branch == $b) | .worktree.path')
    git -C "$QA_PATH" merge --no-ff <pr-branch>
    ```
    Use `wt list --format=json` to resolve the path instead of hardcoding it; the table also exposes merge-conflict prediction and integration status. Record every conflict-resolution commit in the QA dossier.
5. **Run the verification suite** (typecheck, lint, tests, smoke flows) on the combined state.
6. **Write or update a QA dossier** in `.agents/docs/qa/`:
    ```bash
    bun .agents/skills/agents-docs/scripts/docs.js new coverage "<batch title>" --area <area>
    ```
    Set frontmatter `type: coverage`, add `merge_batch: <slug>` to every dossier in the same batch, and link every per-PR worktree that contributed. Use `status: pending` for the initial write so the corpus index does not surface a half-finished dossier; flip to `active` once the verdict is recorded. Always include a `## Resolution intent` section that records which side was taken for each conflict and why. The corpus index links here so future operators can see the reasoning without re-running the merge.
7. **Capture the verdict** in the dossier:
    - `pass` - no conflicts, all checks green, ready to merge on GitHub
    - `pass-with-fixes` - conflicts resolved with mechanical edits; record the touched files
    - `fail` - non-mechanical conflict, contract drift, or check failure; halt and escalate
8. **Clean up the worktree immediately**, even on pass:
    ```bash
    wt remove qa/<slug> --force
    ```

### Loop-risk guardrails (non-negotiable)

- Never push the QA branch. `qa/<slug>` is local only; it never reaches `origin`.
- Never open a PR from the QA branch. The GitHub merges are the user's decision.
- Never feed `qa/<slug>` back into `no-mistakes axi run`. The `no-mistakes` skill has no merge primitive and cannot drive a GitHub merge for you; re-running the gate on already-validated changes risks an infinite loop.
- Never hardcode the base branch. Detect it via `gh repo view` or `git symbolic-ref` every time.
- Never hardcode shared-contract paths. Use the pattern-based heuristic (condition B) plus any repo-configured `shared-globs`.

### Fixes found during Step 10

- **Never patch the QA worktree.** The `qa/<slug>` worktree is disposable; fixes committed there are lost when it is removed.
- **Fix in the owning source PR branch.** Determine ownership with `git log <base>..<pr-branch> -- <file>`. If both PRs touch the file, fix in the branch that merges last so the final `main` state is correct.
- **Backport any QA-only test/config changes.** If you had to edit `jest.config.js`, `package.json`, or a scenario file in the QA worktree to run the verification, apply that same change to the owning source branch so CI can reproduce it.
- **Push the fix and re-run Step 10 from scratch.** Remove the old QA worktree, create a fresh `qa/<slug>` worktree from the dynamic base, merge the updated PRs again, and verify. Do not re-use the old QA worktree for verification.
- **Update the QA dossier.** Record the new PR commit hashes, the fresh merge commit, and the updated verdict. Mark the old QA worktree dossier as retired or add a `superseded_by` link.
- **File or update the bug dossier.** Use `/agents-docs` to record pre-existing bugs with `pre-existing: true` and the owning branch so the fix location is unambiguous.

### Conflict resolution discipline

- **Use the test suite as the resolution validator, not the diff.** A conflict resolution that looks right in `git diff` can still be a syntax error. Always run the verification suite after every resolution pass. If a pass introduces failures, restore the file from `git show <branch>:<file>` rather than reverse-engineering the merge tool.
- **Restrict auto-merge helpers to additive-only conflicts.** Union-of-lists, append-sections, and latest-of-N-dates are safe. Anything touching an import block, type definition, or function body should be hand-resolved or driven by `git merge-file --ours` / `--theirs` markers. Regex drivers collapse adjacent blocks (for example an `import { ... }` block followed by a function body), producing syntax errors that are invisible to `git diff` but immediate to `bun test` or `tsc`.
- **For doc, comment, or README conflicts, validate factual claims against the source code.** Run `ls`, `grep`, or the equivalent against the actual codebase before trusting the incoming side. A plausible-looking paragraph can describe features, packages, or commands that do not exist; the merge tool will not catch this.

### Relationship to `/visual-qa`

Step 10 and `/visual-qa` are orthogonal. They run at different times, answer different questions, and produce different outputs. Do not merge them into one skill.

|                 | Step 10 (local merge-preview QA)                                                             | `/visual-qa`                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Question        | "Will this combined merge land cleanly on the target branch and keep tests passing?"         | "After the merge, does the running UI behave and look right?"                                     |
| Runtime         | Disposable merge worktree; no app instance needed                                            | Running app + `orca-cli` headed browser pane                                                      |
| Timing          | Before the GitHub merge                                                                      | After the merge is on `main` or a deployed preview                                                |
| What it catches | Semantic conflicts, shared-contract drift, merge-order bugs, test failures on combined state | Visual regressions, broken flows, console/network errors, accessibility gaps                      |
| Output          | QA dossier with conflict table + `## Resolution intent`                                      | Per-flow dossiers + Prodigy-style HTML report                                                     |
| Auto-fix        | No. Step 10 documents resolutions; fixes flow back to source PR branches.                    | Yes, for high-confidence mechanical findings on a disposable `auto-fix/visual-qa-<batch>` branch. |

**Hand-off pattern.** After Step 10 records a `pass` or `pass-with-fixes` verdict, the operator may run `/visual-qa` against the merged app to validate user-perceived behavior. The Step 10 dossier ends its `## Resolution intent` section with:

```markdown
For visual QA of the merged feature, see `/visual-qa`.
```

The `/visual-qa` dossier links back to the Step 10 dossier under `related:` in the frontmatter. Discovery is through the corpus index, not through a pipeline step.

## Integration with other skills

| Skill                        | How /review-gate uses it                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/no-mistakes`               | User-level skill that owns generic `axi run` driving. `/review-gate` focuses on scope preparation and findings capture; it does not duplicate the full pipeline-decision loop. |
| `/agents-docs`               | Owns the QA dossier in `.agents/docs/qa/`. `/review-gate` writes findings straight into the dossier through `/agents-docs`.                                                    |
| `/worktrunk-orca-delegation` | Robust parallel dispatcher. `/review-gate` is the per-worktree task it dispatches.                                                                                             |

## Rules

- **Intent is required.** Pass the user's goal verbatim in `--intent`; do not condense it into a diff summary.
- **Branch first.** The work must be committed on a feature branch before `axi run`.
- **Use `--yes` for unattended agent runs.** This auto-accepts `review: awaiting_approval` and `lint: awaiting_approval` gates and lets the pipeline auto-fix actionable findings.
- **Skip `ci` by default for review-gate.** Use `--skip ci` with `--yes` so the pipeline pushes the branch and opens a PR, then returns without waiting for merge. Use `--skip push,pr,ci` only for a review-only gate where the branch must not be published.
- **Check status with `no-mistakes axi status`.** It is the supported way to see the current step, findings, and branch sync state without blocking on the run.
- **Respect `pipeline_owned` state.** When `branch_sync.state` is `pipeline_owned`, the pipeline has rewritten the branch head. Do not make local follow-up commits until the run completes.
- **Recover from a hung CI monitor.** If a run reaches the `ci` step and monitors indefinitely, cancel it with `no-mistakes axi abort` and then run `no-mistakes axi sync --check` to recover the branch. The PR remains open and the branch stays synchronized.
- **QA dossier is the source of truth.** Write findings straight into `.agents/docs/qa/` through `/agents-docs`. Do not maintain a parallel `.review-gate/` report directory.
- **Delegated over standalone.** Prefer `/worktrunk-orca-delegation` for parallel reviews; use the fallback only when that skill is not active.
- **No embedded doc lifecycle.** Do not recreate `/agents-docs` templates, index logic, or frontmatter rules.
- **Context-pointer coupling.** When another skill needs review, link to `/review-gate`; do not copy its steps.
- **Wait asynchronously.** `no-mistakes axi run`, `respond`, and `status` can block for minutes. Start them with `bg_run`, then wait for the `<background-task-notification>`. Do not poll with repeated `ps`, `bg_status`, or synchronous `no-mistakes axi status` calls.

## Completion criteria

A `/review-gate` run is complete when:

- the no-mistakes run has reached an `outcome:`
- if `/agents-docs` is active, the QA dossier in `.agents/docs/qa/` is created or updated and the index is regenerated
- the user knows the next action (fix, merge, escalate, or re-run)
- when multiple PRs are queued, Step 10 (local merge-preview QA) has run and recorded a verdict

## Troubleshooting

- **`axi run` refuses the default branch** - create and commit on a feature branch first.
- **Review only covers changes** - this is expected; use a scoped intent to inspect existing code areas.
- **Stage shows `review: awaiting_approval` (or `lint: awaiting_approval`)** - this is normal. If you started with `--yes`, the gate is auto-accepted and the run continues into `fixing`. If you did not use `--yes`, answer the gate with `no-mistakes axi respond`.
- **`ci` runs forever** - the `ci` step monitors the PR until it is merged or closed; it is not stuck. Use `--skip ci` to push/open a PR without monitoring, or `--skip push,pr,ci` for a review-only gate that must not publish. If a CI monitor is already running too long, abort it with `no-mistakes axi abort` and then `no-mistakes axi sync --check`.
- **`branch_sync.state` is `pipeline_owned`** - the pipeline has applied auto-fix commits and owns the branch head. Wait for the run to finish before making any local commits.
- **Parallel fallback stalls** - check Orca terminal state and nudge with `terminal send --text "" --enter` if a prompt did not submit. See `/worktrunk-orca-delegation` for the full health-check pattern.
- **Findings dossier is missing** - `/review-gate` must write the QA dossier in `.agents/docs/qa/` via `/agents-docs` before declaring completion.
- **Stuck polling no-mistakes status** - stop the polling loop, then relaunch the long command with `bg_run` and a sensible timeout. Use the `<background-task-notification>` as the only wake-up signal. Read `bg_logs` once after the notification if you need the gate output. Do not poll `git status` while waiting; it does not reflect pipeline progress and only burns turns.

## See also

- [REFERENCE.md](REFERENCE.md) - exact fallback commands, report template, and integration examples.
