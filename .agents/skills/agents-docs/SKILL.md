---
name: agents-docs
description: Maintain the `.agents/docs/` corpus (index, log, Lavish sync). Triggers for doc lifecycle or corpus QA.
---
# agents-docs

Manage the `.agents/docs/` knowledge corpus.
Docs are the source of truth; Lavish artifacts are throwaway mirrors.

> **Docs first.** Sync the doc before editing any Lavish artifact.
> The script only does deterministic bookkeeping - moves, link rewrites, index/log regen.
> It never guesses; ambiguous decisions fail loudly.

## Plan-only mode

Start in plan-only mode.
Describe the intent, affected docs, and expected outcome before running any state-changing command (`ensure --apply`, `new`, `archive`, `abandon`, `revive`, `scaffold-worktrees`, `clean`, `sync`, `visual`, `index`, `prune --apply`).

- Edits inside `.agents/docs/` are allowed as the planning surface.
- Never edit application code, configs, scripts, tests, or build files outside `.agents/docs/` without explicit user approval.
- This applies even when the user names a command directly: present the plan and wait.

## Quick start

1. Run `bun .agents/skills/agents-docs/scripts/docs.js ensure --dry-run` to see the structure migration plan (first run only).
2. After review, run `ensure --apply`, then `status` and `report --check` to verify the corpus is conformant.
3. Create docs with `new <type> <title> [--area frontend|backend|fullstack]`.
4. Regenerate the catalog with `index` after any manual edit; run `report [--html]` to see the corpus health at a glance.

## The 6 folders

| Folder | Holds | Type |
|---|---|---|
| `research/` | exploration, options, trade-offs before a decision | research |
| `plans/` | actionable architecture plans; deferred stays as `status: deferred` | plan |
| `worktrees/` | flight logs for active branch worktrees | worktree |
| `bugs/` | active incident side-channel: open -> fixed/wontfix | bug |
| `qa/` | verification dossiers, coverage matrices, and review records | coverage / dossier |
| `archive/` | terminal docs (complete, dropped, landed, fixed) | historical |

`area` (frontend | backend | fullstack) is a field and filename prefix (`<area>-<kebab-title>.md`), not a directory.
For the complete frontmatter schema and stale windows, see [REFERENCE.md](REFERENCE.md).

> **Worktree Dispatch Lifecycle:**
> Plans specify execution tracks in `## Worktree Strategy`.
> Running `scaffold-worktrees <plan-doc>` generates isolated `worktrees/<area>-<slug>.md` flight logs.
> These flight logs serve as the unambiguous dispatch contracts for `/worktrunk-orca-delegation`.
> Workers transition flight logs from `active` to `landed`, and verification findings flow into `qa/` dossiers.

## Core workflows

### ensure - converge the tree to the 6-folder structure

`ensure --dry-run` plans every change (folder moves, area-prefix renames, frontmatter conformance, link rewrites, empty-folder removals) and writes nothing.
It also flags decisions it will not make: duplicate research/archive doc pairs and docs whose `type` cannot be inferred.
Review the map, then run `ensure --apply`.
This command is idempotent.

### new - create a doc from a template

`new <type> <title> [--area <area>]` creates `<area>-<kebab-title>.md` in the type's folder with the OKF template, then regenerates the index.
The description placeholder must be replaced with a real one-line summary.

When creating a `plan`, evaluate worktree granularity:
- Default to a single worktree for small or tightly coupled changes.
- Define structured parallel tracks in `## Worktree Strategy` for independent features.
- For stacked or multi-phase plans, declare execution phases with `depends_on`, `stack_position` (the phase/wave number, where parallel worktrees in the same wave share the same position), and `stack_batch` in `## Worktree Strategy`.
- Fill in the `## Tools / MCP / Skills` section with the native tools, MCP servers, and agent skills the plan depends on.
- Conclude the planning turn by asking the user if they want to dispatch the planned worktree(s).

### scaffold-worktrees - JIT worktree generation

`scaffold-worktrees <plan-doc>` parses the `## Worktree Strategy` section (or deliverables table) from a plan and auto-generates isolated `worktrees/<area>-<slug>.md` flight logs.
Each generated worktree doc is born linked to the parent plan (`related: [../plans/<plan>.md]`).

### promote - research to a plan

When research reaches a decision, write a plan (or `new plan`), then set the research doc `status: complete` + `superseded_by: <plan>` and `archive <doc>` it.
The plan links back to the research for provenance.

### defer / park a plan

Set the plan's `status: deferred` and run `archive <plan> --status deferred`.
The plan moves to `archive/plan-<name>.md` and can be revived when research or dependencies unblock.

### complete / archive / abandon - move a done doc to archive/

Set the terminal status (`plan: complete|dropped`, `worktree: landed|abandoned`, `bug: fixed|wontfix`, `research: complete|dead-end`, `coverage: retired`), then `archive <doc>`.
The script moves it to `archive/<type>-<basename>.md`, rewrites inbound + outbound links to file-relative, and appends `log.md`.

`abandon <doc>` is a one-step shortcut: it archives with the default terminal status for the doc's type (`plan` -> `dropped`, `worktree` -> `abandoned`, `bug` -> `wontfix`, `research` -> `dead-end`, `coverage` -> `retired`).
Override with `--status=<v>`.
Use it when a doc is being left behind mid-process without a full review.

> **Evidence gate for research.** `archive <research-doc> --status complete` is refused while `scripts/evidence.js` reports critical flags (missing sources, unsourced negative claims about external products, low-confidence critical findings).
> Resolve the flags, or archive as `dead-end` instead.
> Run `bun .agents/skills/agents-docs/scripts/evidence.js --all` to audit every research doc; see REFERENCE.md for the rule list.

### revive - restore an archived doc to active status

`revive <archive-doc>` moves any archived doc from `archive/<type>-<basename>.md` back to its active home folder (e.g. `research/`, `plans/`, `worktrees/`, `bugs/`), sets its status to `active` (or `open` for bugs), resets its staleness deadline, rewrites links, and regenerates the index.

> **Auto model.** "Done" is declared by you in frontmatter.
Every lifecycle command runs a dry `clean` sweep at the end: terminal docs are surfaced for archiving, superseded archive docs are surfaced for GC after TTL (default 180d), and stale active docs are surfaced for a decision.
The sweep never moves or deletes files without `--apply`.

### clean - the auto-archive / auto-prune sweep

`clean [--apply] [--stale-orphan] [--force] [--ttl <days>]` is what `maybeSweep` calls.
Dry-run by default; pass `--apply` to actually archive or GC files.
Use it explicitly when you want to run the sweep without performing a lifecycle command, or to preview before merging work.
It runs at the end of `new`, `visual`, `sync`, `archive`, `abandon`, `revive`, `scaffold-worktrees`, and `ensure --apply` automatically - but only as a dry-run that surfaces candidates and alerts.

`--stale-orphan` archives active docs that are both stale (per type-specific thresholds) AND unreferenced.
This is also dry-run by default; pass `--apply` to actually move files.
Entry-point docs (`entry_point: true`) and still-referenced docs are never included.

Output buckets: auto-archive, stale alerts, stale-orphan candidates, archive summary, gc-refused, anomalies.

### visualize + sync - the Lavish loop

Interactive review sessions use [`lavish-axi`](https://github.com/kunchenguid/lavish-axi) (on-demand via `npx -y lavish-axi <file>` or installed globally via `npm install -g lavish-axi`).

1. Generate the HTML artifact at `.lavish/<name>.html` and register it: `visual <doc> .lavish/<name>.html`.
2. Open with `lavish-axi <file>` (or `npx -y lavish-axi <file>`), then `lavish-axi poll <file>` (foreground, never kill).
3. On feedback: **sync the doc first** - update the markdown, run `sync <artifact> --message "<what changed>"`, then edit the HTML to match, then re-poll.
4. `Send & End` closes the session; deliver remaining updates in-conversation, never reopen uninvited.

### prune - propose archiving, then garbage-collect

`prune` is the explicit, batched version of `clean` - useful when you want to walk through candidates one at a time and decide.
`prune --dry-run` proposes archive moves from deterministic frontmatter (terminal status, `superseded_by`).
`prune --apply` moves them.
`prune --gc --dry-run` proposes deleting archive docs that are superseded AND past the retention window (default 180 days, `--ttl` to change) - the only path that ever deletes, and `log.md` keeps a trace line.
`prune --gc` is dry-run by default; `prune --gc --apply` deletes.
An archive doc that is still referenced from a live doc is refused with the linker names; pass `--force` to override.

### review - status, report, index

- `status [--show-archive] [--show-orphan]` - ultra-compact summary of active files grouped by folder x area x status with stale/orphan flags.
Run this as the primary, fast (~50 tokens) LLM discovery tool to survey active work without reading large markdown files.
Archive collapses to one summary line (`archive/: N docs, oldest X, K !not-terminal`); `--show-archive` expands.
Orphans are summarized by default (`--show-orphan` expands the per-row flag) because entry-point docs and dossier sub-items are legitimately unreferenced.
- `report [--html] [--check] [--show-archive] [--show-orphan]` - sortable corpus health (the "git status" of the corpus); `--html` writes a standalone dashboard, `--check` exits non-zero on stale / dangling / nonconformant.
Orphan is advisory - entry-point docs are legitimately unreferenced.
Archive docs never gate: an anomaly (archived doc reading as non-terminal) surfaces but does not fail `--check`.
- `index` - regenerate the catalog (`index.md`) from frontmatter. Use `index.md` when an agent or human is reading the repo statically from disk without executing shell commands.

## Checkpoints & reply scaling

The corpus is the contract behind parallel work.
Plans hand off to `/worktrunk-orca-delegation`; worktrees track `active -> landed`; bugs enter `bugs/` mid-flight; `/review-gate` writes findings into `qa/` dossiers.

> **Commit docs before delegating.** Worker agents run in linked git worktrees that inherit the committed state of their base branch. Any plan, worktree flight log, or decision updated in the orchestrator's checkout must be committed to the default branch before `wt switch --create` or `orca orchestration worker-start`, or the worker will see stale or missing docs.

### Failure triage & bug resolution lifecycle

When a test/build failure is discovered during a worktree/QA pass, classify it before recording it:

1. **Regression** - introduced by the current change. File a `bug` doc with `status: open` and `owning_branch: <branch>`; it blocks the merge.
2. **Pre-existing** - reproduces on `main` or the source branch, unrelated to the current change. File a `bug` doc with `pre-existing: true` and `owning_branch: <branch>`; link it from the QA dossier; it does not block the merge.
3. **Environmental / tooling** - sandbox, known tool bugs, network flakes, auth issues. Do **not** file a `bug` doc; note it inline in the QA dossier only.

> **Bug Resolution Archiving Protocol:**
> When an open bug in `bugs/<area>-<slug>.md` is later solved in a dedicated worktree:
> 1. The fix PR undergoes `/review-gate`, producing a new verification dossier in `qa/<fix-batch>.md`.
> 2. In `bugs/<area>-<slug>.md`, set `status: fixed` and `superseded_by: ../qa/<fix-batch>.md`.
> 3. Running `archive <doc>` (or the automatic `clean` sweep) moves the doc to `archive/bug-<area>-<slug>.md`.
> Resolved bugs never move into `qa/`; `qa/` holds the immutable verification evidence, while `archive/` holds the closed ticket history.

Always attempt to reproduce on the base branch before filing.
Use the **Reliable 3-Step Pre-Existing Detection Protocol**:
1. **Base Inspection:** Check if the problematic code/warning exists on the base branch (`git show <base>:<file>`).
2. **Diff Ownership:** Check `git diff <base>...HEAD -- <file>`. If the offending lines were NOT introduced or modified by this PR's diff, it is `pre-existing: true`.
3. **Historical Tracing:** Run `git log -S "<symbol>" <base>` to confirm the historical commit on base that introduced it.

When ownership is ambiguous, run `git log <base>..<branch> -- <file>` for each candidate branch.
The branch whose unique commits last touched the file is the `owning_branch`.
If both branches touched it, prefer the branch that merges last so the fix lands on `main` in the correct order.

### Weekly cleanup cadence

```bash
bun .agents/skills/agents-docs/scripts/docs.js status
bun .agents/skills/agents-docs/scripts/docs.js report --check
bun .agents/skills/agents-docs/scripts/docs.js clean --stale-orphan
# review dry-run, then:
bun .agents/skills/agents-docs/scripts/docs.js clean --stale-orphan --apply
bun .agents/skills/agents-docs/scripts/docs.js prune --gc --dry-run
# review GC candidates, then:
bun .agents/skills/agents-docs/scripts/docs.js prune --gc --apply
```

### Reply scale

| change | reply |
|---|---|
| small | plain text |
| big, no decision pending | `report --html` at `.lavish/docs-report.html` |
| big, decision pending | interactive Lavish; sync the doc first, never background the poll |

## Rules

- Verify dependency and version claims with ecosystem-appropriate commands (e.g. `npm view <pkg> version`, `pip index versions <pkg>`) before citing them in a research doc, and record the command as `verified-by: <command>` in the Evidence column. This is authoring guidance - `evidence.js` checks that evidence slots are filled, not that you ran the command.
- Frontmatter is the source of truth for status/area/freshness; the body holds prose read once a doc is chosen.
- Never overwrite an existing frontmatter field; `ensure` only adds missing fields.
- `archive/` docs are historical - no `type` is guessed for them.
- Archive destination is flat `archive/<type>-<basename>.md` to prevent name collisions across document kinds. Collisions fail loudly (`target exists`), never overwrite.
- Script failures are loud: the script never makes a semantic decision.
- File-relative links only; `.agents/docs/...` absolute links are rewritten on migration and discouraged.

## Troubleshooting

- **`report --check` fails on dangling** - a doc links to a path that does not exist. Fix the reference (or remove it) before considering the corpus healthy.
- **`new` says "already exists"** - the target filename exists; pick a distinct title or reuse the existing doc.
- **`archive` says "target exists"** - the type-prefixed filename already lives in `archive/`; decide which copy is canonical and remove the other before retrying.
- **`clean` reports `auto-archive-skip: target exists`** - collision surfaced during auto sweep; the live copy was left in place, fix the collision manually. The sweep continues.
- **`clean` reports `!not-terminal archive/<doc>`** - an archived doc reads with an unknown/active status. Add a terminal status (`complete`/`landed`/`fixed`/etc.) so the archive health reads `ok` instead of `not-terminal`.
- **`clean` reports `gc-refused <doc> (still referenced by <linker>)`** - the archive doc is still evidence for a live doc. Either update the linker to point elsewhere first, or pass `--force` to override (leaves the live doc with a dangling link).
- **`sync` says "no doc maps to artifact"** - run `visual <doc> <artifact>` first so the `visual:` frontmatter key links the artifact to its doc.
- **`ensure` flags "cannot infer type - manual"** - the doc is in an unexpected folder; set `type` by hand.

## See also

- [REFERENCE.md](REFERENCE.md) - frontmatter field reference, per-type templates, folder mechanics, full subcommand reference, Lavish protocol, reviewability design.
- [EXAMPLES.md](EXAMPLES.md) - worked lifecycle including a feedback -> sync -> re-poll cycle.
