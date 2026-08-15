---
name: review-gate
description: Run a `no-mistakes axi run` review on a branch or codebase scope. Use when gating, reviewing, or pre-merge QA-ing a branch, worktree, or stacked PR.
user-invocable: false
---

# review-gate

Drive [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) (`no-mistakes axi run`) for code-level review and pre-merge QA.
Findings are captured in `.agents/docs/qa/` dossiers; parallel reviews delegate to `/worktrunk-orca-delegation`.

> **Docs first.**
> When `/agents-docs` is active, capture findings directly into a `.agents/docs/qa/` dossier.
> There is no local report step: the QA dossier is the single source of truth.

## Quick start

1. **Resolve scope.**
   Pick a branch and an intent that names what to review.
   For whole-codebase coverage, use a small branch diff plus an intent that lists the areas to inspect.
2. **Run the gate according to environment:**
   - **Local-Only Repository (No remote / no GitHub):**
     ```bash
     no-mistakes axi run --intent "Review <area>: ..." --yes --skip push,pr,ci
     ```
     Runs completely offline, executing local linters, typechecks, and tests within the worktree.
   - **GitHub-Connected Repository (With remote PRs):**
     ```bash
     no-mistakes axi run --intent "Review <area>: ..." --yes --skip ci
     ```
     Pushes the validated branch and opens a GitHub PR.
3. **Drive the findings.**
   Approve, fix, or escalate `ask-user` findings as the pipeline surfaces them.
4. **Capture the result.**
   Create or update a QA dossier in `.agents/docs/qa/` through `/agents-docs`.

### Long-running reviews

`no-mistakes axi run` can take 20-60 minutes for a deep review.
Run it asynchronously through your agent harness's background command runner, a dedicated terminal, or the bundled polling script so the agent is not blocked by a shell timeout:

```bash
# Run asynchronously in your harness (e.g. AGY async task, Claude background Bash, or dedicated terminal):
no-mistakes axi run --intent "Review <area>: ..." --yes --skip push,pr,ci

# Or launch inside a dedicated Orca terminal pane:
orca terminal create \
  --title "review-gate <branch>" \
  --command "cd <worktree> && no-mistakes axi run --intent '...' --yes --skip push,pr,ci" \
  --json
```

Then continue with other work.
Your harness notification or Orca terminal status resumes the agent when the run reaches an outcome.
A short `bash` timeout can kill the CLI while the daemon is still in `review: fixing`, leaving the run hard to monitor and resume.

### Polling wrapper for approval gates

Use the bundled polling script to watch a run and unblock parked gates deterministically:

```bash
cd /path/to/qa-worktree
bash /path/to/.agents/skills/review-gate/scripts/poll-no-mistakes.sh [poll-interval-seconds]
```

- **Default:** auto-fixes mechanical issues and exits on `ask-user` findings for manual review.
- **Unattended `ask-user` approval:** `AUTO_APPROVE_ASK_USER=1 bash .../poll-no-mistakes.sh 30`.
- For daemon socket and JSON-RPC mechanics, see [REFERENCE.md](REFERENCE.md).

## Core workflow

### Resolve scope

A no-mistakes review inspects committed changes against a base.
To review existing code that is not part of a large diff, keep the branch diff small and make the `--intent` explicit about which files, modules, or risks to inspect.

| Situation                   | Branch                             | Intent                                                 |
| --------------------------- | ---------------------------------- | ------------------------------------------------------ |
| Default (when in doubt)     | disposable merge-preview worktree  | review the exact state that will ship                  |
| Current feature branch      | the feature branch                 | review the changes plus named surrounding code         |
| Named area of existing code | a small branch (or current branch) | list the files/modules and the specific risks to check |
| Pre-merge validation        | the worktree branch                | verify the branch against its merge contract           |
| Already-merged changes      | the integration branch             | review the commits that landed without a gate          |

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

# Run the gate (review-only; do not publish) asynchronously
no-mistakes axi run \
  --intent "Review combined vision-proxy CLI migration: verify CLI core and hook shims integrate cleanly" \
  --yes \
  --skip push,pr,ci
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

### Diff-Scope Gating & Second-Review Cost Protection

When a preview worktree has already passed review once and the base branch advances:
1. Inspect the base changeset: `git diff <old-base>..<new-base> --stat`.
2. **Doc/Skill-Only Diffs:** If all modified files are in `.agents/docs/`, `.agents/skills/`, or `*.md`, pull base forward (`git merge <base>`) and run local verification (`pnpm test && fallow audit`). **DO NOT re-run `no-mistakes axi run`.**
3. **Code Diffs Outside PR Scope:** Prompt the user with a token/time cost estimate (variable ~20–60+ min run) before triggering a second full review.

### Single review

Run the gate on one branch and drive it to outcome:

```bash
no-mistakes axi run --intent "<what the user set out to accomplish>"
```

Loop on `gate:` objects with `no-mistakes axi respond` until the run reaches an `outcome:`.
For the exact commands and decision rules, see the user-level `/no-mistakes` skill or [REFERENCE.md](REFERENCE.md).

### Approval gates and unattended runs

Use `--yes` for unattended agent runs so approval gates auto-accept and actionable findings move into `review: fixing`:

```bash
no-mistakes axi run --intent "..." --yes
```

- **Unattended auto-fix:** enable up to 3 self-healing rounds by committing `.no-mistakes/config.yaml` (`auto_fix: { review: 3 }`).
- **Parked gates:** when auto-fix is disabled, poll `no-mistakes axi status` for parked gates and respond via `no-mistakes axi respond --action approve` or `--action fix --findings <ids>`.
- **Pipeline-owned head:** when `branch_sync.state` is `pipeline_owned`, the pipeline has rewritten the branch head with auto-fixes. Do not make local commits until outcome is reached.

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

### Findings output & routing

Create or update the QA dossier directly in `.agents/docs/qa/` via `/agents-docs`:

```bash
bun .agents/skills/agents-docs/scripts/docs.js new coverage "<title>" [--area <area>]
```

Route findings according to their lifecycle to avoid polluting `bugs/`:

| Finding Type | Where it Lands | Lifecycle & Mechanics |
|---|---|---|
| **Auto-Fixed by CLI** | `qa/<batch>.md` | Recorded in the QA dossier table under `## Auto-Fixed Findings` with commit hashes (verdict `pass-with-fixes`). No `bugs/` doc needed. |
| **Resolved `ask-user`** | `qa/<batch>.md` | Recorded in `## Resolution intent` explaining the choice taken and why. |
| **Deferred `ask-user`** | `bugs/<area>-<slug>.md` | Created via `docs.js new bug "<title>"` (`status: open`) linking back to `related: [../qa/<batch>.md]`. |
| **Pre-Existing Flaws** | `bugs/<area>-<slug>.md` | Created with `pre-existing: true` and owning branch metadata so PR is not blocked. |

> **Bug Resolution Archiving Protocol:**
> When a bug recorded in `bugs/<area>-<slug>.md` is later fixed in a dedicated worktree, the fix verification is recorded in the new QA dossier (`qa/<fix-batch>.md`).
> The bug doc is updated to `status: fixed` with `superseded_by: ../qa/<fix-batch>.md`, and archived to `archive/bug-<area>-<slug>.md` via `bun docs.js archive bugs/<slug>.md` (or `bun docs.js clean --apply`).
> Resolved bugs never move into `qa/`; `qa/` holds the verification evidence, while `archive/` holds the closed ticket history.

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
    wt merge <pr-branch> # or git -C "$QA_PATH" merge --no-ff <pr-branch>
    ```
    Use `wt list --format=json` to resolve the path instead of hardcoding it; the table also exposes merge-conflict prediction and integration status. Record every conflict-resolution commit in the QA dossier.
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

- **Never patch or ship the disposable preview worktree.**
  The `qa/<slug>` / `int-merge` worktree is disposable; fixes committed directly there are lost when the worktree is destroyed, and the preview branch must NEVER be pushed to `origin`.
- **Fix in the owning source PR branch.**
  Determine ownership with `git log <base>..<pr-branch> -- <file>`.
  If both PRs touch the file, fix in the branch that merges last so the final `main` state is correct.
- **Backport any QA-only test/config changes.**
  If you had to edit `jest.config.js`, `package.json`, or a scenario file in the QA worktree to run verification, apply that same change to the owning source branch so CI can reproduce it.
- **Push the fix and re-run Step 10 from scratch.**
  Remove the old QA worktree, create a fresh `qa/<slug>` worktree from the dynamic base, merge the updated PRs again, and verify.
  Do not re-use the old QA worktree for verification.
- **Update the QA dossier.**
  Record the new PR commit hashes, the fresh merge commit, and the updated verdict.
  Mark the old QA worktree dossier as retired or add a `superseded_by` link.
- **File or update the bug dossier.**
  Use `/agents-docs` to record pre-existing bugs with `pre-existing: true` and the owning branch so the fix location is unambiguous.

### When no-mistakes auto-fixes the disposable preview

When `--yes` causes `no-mistakes axi run` to auto-fix linter, typecheck, or code findings, it commits those fixes directly onto the local `qa/<slug>` / `int-merge` head.
Because the preview branch is strictly disposable and must never be pushed to origin, follow this 6-step recovery loop:

1. **Read the auto-fix diff:**
   Inspect the exact commits applied by the review daemon with `git log -n 5` and `git show HEAD`.
2. **Trace the owning feature branch:**
   Run `git log <base>..<feature-branch> -- <file>` for each modified file to locate the feature branch that introduced the issue.
3. **Re-apply the fixes in the owning feature branch:**
   Switch to the owning feature branch (or worktree) and cleanly apply or cherry-pick the required changes.
4. **Commit and verify on the feature branch:**
   Commit the fixes on the feature branch with a descriptive message and ensure local tests pass.
5. **Destroy the disposable preview:**
   Run `wt remove qa/<slug> --force` to delete the auto-fixed preview branch.
6. **Re-create and re-merge the stack:**
   Re-create `qa/<slug>` from the base branch, re-merge all feature branches in declared stack order, and re-run verification.

### Manual stacked-PR workflow

The local merge-preview workflow mirrors GitHub's stacked pull requests feature for local development:

- **Stack Declaration:**
  Each branch in the stack declares its upstream dependency via `depends_on: [../worktrees/<parent>.md]` and `stack_position: <n>` in its flight log.
- **Merge Order Rule:**
  Always merge the bottom layer of the stack first (`stack-01`).
  After `stack-01` lands into the base branch, rebase or retarget `stack-02` onto the updated base before merging.
- **Preview Integration:**
  The `qa/<slug>` worktree merges the entire stack in bottom-to-top order to validate combined contract stability before individual feature branches are landed.

### Conflict resolution discipline

- **Use the test suite as the resolution validator, not the diff.** A conflict resolution that looks right in `git diff` can still be a syntax error. Always run the verification suite after every resolution pass. If a pass introduces failures, restore the file from `git show <branch>:<file>` rather than reverse-engineering the merge tool.
- **Restrict auto-merge helpers to additive-only conflicts.** Union-of-lists, append-sections, and latest-of-N-dates are safe. Anything touching an import block, type definition, or function body should be hand-resolved or driven by `git merge-file --ours` / `--theirs` markers. Regex drivers collapse adjacent blocks (for example an `import { ... }` block followed by a function body), producing syntax errors that are invisible to `git diff` but immediate to `bun test` or `tsc`.
- **For doc, comment, or README conflicts, validate factual claims against the source code.** Run `ls`, `grep`, or the equivalent against the actual codebase before trusting the incoming side. A plausible-looking paragraph can describe features, packages, or commands that do not exist; the merge tool will not catch this.

### Visual QA hand-off

Step 10 validates code/contract integrity before merging.
For user-perceived visual regression testing after merge, record a handoff in the dossier to `/visual-qa` with reciprocal `related:` frontmatter links.

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
- **Wait asynchronously.** `no-mistakes axi run`, `respond`, and `status` can block for minutes.
  Start them asynchronously via your agent harness's background task runner, a dedicated terminal pane, or the bundled polling script.
  Do not poll with repeated `ps` or synchronous CLI calls in a tight loop.

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
- **Stuck polling no-mistakes status** - stop the polling loop, then relaunch the command asynchronously or in a dedicated terminal pane.
  Wait for the background completion signal or use `scripts/poll-no-mistakes.sh`.
  Do not poll `git status` while waiting; it does not reflect pipeline progress and only burns turns.

## See also

- [REFERENCE.md](REFERENCE.md) - exact fallback commands, report template, and integration examples.
