---
name: grill-with-agents-docs
description: Grill the user on a design tree via a Lavish questionnaire grounded in `.agents/docs`.
disable-model-invocation: true
---

Sharpen a plan, design tree, or corpus audit in **one batch** using an interactive Lavish review surface grounded in `.agents/docs/`.
Docs are the source of truth; Lavish artifacts are throwaway mirrors.

## Protocol

1. **Ground against the corpus.**
   Call `/agents-docs` to inspect active plans, research, and corpus health (`status`, `report`).
   Read active docs in `plans/` and `research/` to extract settled facts and architecture constraints.
   If `.agents/docs/` is empty or lacks relevant docs, fall back to baseline `grill-me` discovery.
   *Never ask the user for facts already recorded in the corpus.*

2. **Compute the frontier.**
   Map the design tree and identify all unblocked questions whose prerequisites are settled.
   For each frontier decision, provide:
   - The question and trade-offs.
   - A concrete, opinionated recommendation with a one-line rationale.
   - Mutually exclusive options (radios) or composable options (checkboxes).

3. **Target the document (Conditional routing).**
   - **Exploratory / undecided topic:** Create `.agents/docs/research/questionnaire-<slug>.md` via `/agents-docs`.
   - **Existing draft plan:** Target `.agents/docs/plans/<plan>.md` directly.
   - **Corpus hygiene / prune audit:** Target stale/orphan candidates surfaced by `/agents-docs` clean dry-run.

4. **Mirror to Lavish.**
   Generate `.lavish/questionnaire-<slug>.html` following the `/lavish` `input` playbook.
   Pre-check recommended options so the reviewer can accept them with 1 click or toggle exceptions.
   Register mirror: call `/agents-docs` to link `<doc>` and `<artifact>` (`visual`).
   Launch and poll the review session using `/lavish`.

5. **Sync, promote, and auto-archive.**
   When the user submits in Lavish, record chosen answers directly into the target doc.
   - **If research settles:** Call `/agents-docs` to promote to plan (`new plan <slug>`). Mark research `status: complete` + `superseded_by: ../plans/<slug>.md` and archive via `/agents-docs`.
   - **If plan settles:** Structure `## Worktree Strategy` and offer immediate dispatch via `/worktrunk-orca-delegation`.
   - **If prune audit:** Apply batch cleanup via `/agents-docs` clean and prune.

6. **Post-execution archiving & GC sweep.**
   When dispatched worktrees land and pass QA review (`/review-gate`), archive the executed plan via `/agents-docs`.
   Subsequent `/agents-docs` clean sweeps auto-GC superseded archive files past their retention TTL (default 180d).

## Integration with other skills

| Skill | How /grill-with-agents-docs uses it |
|---|---|
| `/agents-docs` | Owns the OKF corpus (research, plans, worktrees, archive), visual registration, and doc lifecycle. |
| `/lavish` | Renders the interactive HTML review surface and polls for 1-click batch responses. |
| `/worktrunk-orca-delegation` | Dispatches the parallel worktrees structured in the promoted plan. |
| `/review-gate` | Validates worktrees pre-merge before the plan transitions to archive. |
