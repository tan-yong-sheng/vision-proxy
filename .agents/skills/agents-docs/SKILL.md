---
name: agents-docs
description: Maintain `.agents/docs/` as an OKF corpus with index, log, and Lavish sync. Use when creating, archiving, pruning, syncing, or checking docs, plans, worktrees, bugs, or QA dossiers.
---
# agents-docs

Manage the `.agents/docs/` knowledge corpus. Docs are the source of truth; Lavish artifacts are throwaway mirrors.

> **Docs first.** Sync the doc before editing any Lavish artifact. The script only does deterministic bookkeeping — moves, link rewrites, index/log regen. It never guesses; ambiguous decisions fail loudly.

## Plan-only mode

Start in plan-only mode. Describe the intent, affected docs, and expected outcome before running any state-changing command (`ensure --apply`, `new`, `archive`, `clean`, `sync`, `visual`, `index`, `prune --apply`).

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
| `research/` | exploration, options, dead-ends before a decision | research |
| `plans/` | actionable plans; deferred stays here as `status: deferred` | plan |
| `worktrees/` | active branch/worktree working docs | worktree |
| `bugs/` | incident side-channel: open -> fixed/wontfix | bug |
| `qa/` | coverage matrix + `verification/` dossiers | coverage / dossier |
| `archive/` | terminal docs (complete, dropped, merged, fixed) | historical |

`area` (frontend | backend | fullstack) is a field + filename prefix, not a folder. Filenames are `<area>-<kebab-title>.md` with no date - time lives in `created`/`updated`.

## Core workflows

### ensure - converge the tree to the 6-folder structure

`ensure --dry-run` plans every change (folder moves, area-prefix renames, frontmatter conformance, link rewrites, empty-folder removals) and writes nothing. It also flags decisions it will not make: duplicate research/archive doc pairs and docs whose `type` cannot be inferred. Review the map, then `ensure --apply`. Idempotent - re-running reports "corpus already conformant".

### new - create a doc from a template

`new <type> <title> [--area <area>]` creates `<area>-<kebab-title>.md` in the type's folder with the OKF template, then regenerates the index. The description placeholder must be replaced with a real one-line summary.

When creating a `plan`, fill in the `## Tools / MCP / Skills` section with the native tools, MCP servers, and agent skills the plan depends on.

### promote - research to a plan

When research reaches a decision, write a plan (or `new plan`), then set the research doc `status: complete` + `superseded_by: <plan>` and `archive <doc>` it. The plan links back to the research for provenance.

### defer - park a plan without dropping it

Set the plan's `status: deferred`. It stays in `plans/` and surfaces under a Deferred section in `index.md`. A deferred plan is not archived until it is either revived or abandoned.

### complete / archive / abandon - move a done doc to archive/

Set the terminal status (`plan: complete|dropped`, `worktree: merged|abandoned`, `bug: fixed|wontfix`, `research: complete|dead-end`, `coverage: retired`), then `archive <doc>`. The script moves it to `archive/`, rewrites inbound + outbound links to file-relative, and appends `log.md`.

`abandon <doc>` is a one-step shortcut: it archives with the default terminal status for the doc's type (`plan` -> `dropped`, `worktree` -> `abandoned`, `bug` -> `wontfix`, `research` -> `dead-end`, `coverage` -> `retired`). Override with `--status=<v>`. Use it when a doc is being left behind mid-process without a full review.

> **Auto model.** "Done" is declared by you in frontmatter. Every lifecycle command runs `clean` at the end: terminal docs auto-archive, superseded archive docs auto-GC after TTL (default 180d), and stale active docs surface for a decision.

### clean - the auto-archive / auto-prune sweep

`clean [--dry-run] [--apply] [--stale-orphan] [--force] [--ttl <days>]` is what `maybeSweep` calls. Dry-run previews; default applies. Use it explicitly when you want to run the sweep without performing a lifecycle command, or to preview before merging work. It runs at the end of `new`, `visual`, `sync`, `archive`, `abandon`, and `ensure --apply` automatically - so a freshly-completed doc moves on its own next command.

`--stale-orphan` archives active docs that are both stale (per type-specific thresholds) AND unreferenced. This is dry-run by default; pass `--apply` to actually move files. Entry-point docs (`entry_point: true`) and still-referenced docs are never included.

Output buckets: auto-archive, stale alerts, stale-orphan candidates, archive summary, gc-refused, anomalies.

### visualize + sync - the Lavish loop

1. Generate the HTML artifact at `.lavish/<name>.html` and register it: `visual <doc> .lavish/<name>.html`.
2. Open with `lavish-axi <file>`, then `lavish-axi poll <file>` (foreground, never kill).
3. On feedback: **sync the doc first** - update the markdown, run `sync <artifact> --message "<what changed>"`, then edit the HTML to match, then re-poll.
4. `Send & End` closes the session; deliver remaining updates in-conversation, never reopen uninvited.

### prune - propose archiving, then garbage-collect

`prune` is the explicit, batched version of `clean` - useful when you want to walk through candidates one at a time and decide. `prune --dry-run` proposes archive moves from deterministic frontmatter (terminal status, `superseded_by`). `prune --apply` moves them. `prune --gc --dry-run` proposes deleting archive docs that are superseded AND past the retention window (default 180 days, `--ttl` to change) - the only path that ever deletes, and `log.md` keeps a trace line. An archive doc that is still referenced from a live doc is refused with the linker names; pass `--force` to override.

### review - status, report, index

- `status [--show-archive] [--show-orphan]` - every doc with folder x area x status and stale/orphan flags. Archive collapses to one summary line (`archive/: N docs, oldest X, K !not-terminal`); `--show-archive` expands. Orphans are summarized by default (`--show-orphan` expands the per-row flag) because entry-point docs and dossier sub-items are legitimately unreferenced.
- `report [--html] [--check] [--show-archive] [--show-orphan]` - sortable corpus health (the "git status" of the corpus); `--html` writes a standalone dashboard, `--check` exits non-zero on stale / dangling / nonconformant. Orphan is advisory - entry-point docs are legitimately unreferenced. Archive docs never gate: an anomaly (archived doc reading as non-terminal) surfaces but does not fail `--check`.
- `index` - regenerate the catalog from frontmatter; the index is generated, never hand-edited.

## Checkpoints & reply scaling

The corpus is the contract behind parallel work. Plans hand off to `/worktrunk-orca-delegation`; worktrees track `active -> merged`; bugs enter `bugs/` mid-flight; `/review-gate` writes findings into `qa/` dossiers.

### Failure triage

When a test/build failure is discovered during a worktree/QA pass, classify it before recording it:

1. **Regression** — introduced by the current change. File a `bug` doc with `status: open` and `owning_branch: <branch>`; it blocks the merge.
2. **Pre-existing** — reproduces on `main` or the source branch, unrelated to the current change. File a `bug` doc with `pre-existing: true` and `owning_branch: <branch>`; link it from the QA dossier; it does not block the merge.
3. **Environmental / tooling** — sandbox, known tool bugs, network flakes, auth issues. Do **not** file a `bug` doc; note it inline in the QA dossier only.

Always attempt to reproduce on the base branch before filing. If the base branch does not have the test (e.g., the test was added by the PR), check the earliest branch that contains the test. Use that evidence to decide whether the failure is pre-existing or a merge interaction.

When ownership is ambiguous, run `git log <base>..<branch> -- <file>` for each candidate branch. The branch whose unique commits last touched the file is the `owning_branch`. If both branches touched it, prefer the branch that merges last so the fix lands on `main` in the correct order.

### Weekly cleanup cadence

```bash
bun .agents/skills/agents-docs/scripts/docs.js status
bun .agents/skills/agents-docs/scripts/docs.js report --check
bun .agents/skills/agents-docs/scripts/docs.js clean --stale-orphan
# review dry-run, then:
bun .agents/skills/agents-docs/scripts/docs.js clean --stale-orphan --apply
bun .agents/skills/agents-docs/scripts/docs.js prune --gc --dry-run
```

### Reply scale

| change | reply |
|---|---|
| small | plain text |
| big, no decision pending | `report --html` at `.lavish/docs-report.html` |
| big, decision pending | interactive Lavish; sync the doc first, never background the poll |

## Rules

- Frontmatter is the source of truth for status/area/freshness; the body holds prose read once a doc is chosen.
- Never overwrite an existing frontmatter field; `ensure` only adds missing fields.
- `archive/` docs are historical - no `type` is guessed for them.
- Archive destination is ALWAYS flat `archive/<basename>.md` (subfolder paths collapse); collisions fail loudly (`target exists`), never overwrite. Provenance is the `type` field, not the filename - `status --show-archive` / `report --show-archive` groups archive rows by source folder.
- Script failures are loud: the script never makes a semantic decision.
- File-relative links only; `.agents/docs/...` absolute links are rewritten on migration and discouraged.

## Troubleshooting

- **`report --check` fails on dangling** - a doc links to a path that does not exist. Fix the reference (or remove it) before considering the corpus healthy.
- **`new` says "already exists"** - the target filename exists; pick a distinct title or reuse the existing doc.
- **`archive` says "target exists"** - the basename already lives in `archive/` (the move is always flat); decide which copy is canonical and remove the other before retrying.
- **`clean` reports `auto-archive-skip: target exists`** - same-basename collision surfaced during the auto sweep; the live copy was left in place, fix the collision manually. The sweep continues.
- **`clean` reports `!not-terminal archive/<doc>`** - an archived doc reads with an unknown/active status. Add a terminal status (`complete`/`merged`/`fixed`/etc.) so the archive health reads `ok` instead of `not-terminal`.
- **`clean` reports `gc-refused <doc> (still referenced by <linker>)`** - the archive doc is still evidence for a live doc. Either update the linker to point elsewhere first, or pass `--force` to override (leaves the live doc with a dangling link).
- **`sync` says "no doc maps to artifact"** - run `visual <doc> <artifact>` first so the `visual:` frontmatter key links the artifact to its doc.
- **`ensure` flags "cannot infer type - manual"** - the doc is in an unexpected folder; set `type` by hand.

## See also

- [REFERENCE.md](REFERENCE.md) - frontmatter field reference, per-type templates, folder mechanics, full subcommand reference, Lavish protocol, reviewability design.
- [EXAMPLES.md](EXAMPLES.md) - worked lifecycle including a feedback -> sync -> re-poll cycle.
