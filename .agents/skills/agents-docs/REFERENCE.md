# agents-docs REFERENCE

Detailed contract for the `.agents/docs` corpus: frontmatter schema, per-type templates, folder lifecycle mechanics, the `docs.js` subcommand reference, the Lavish integration protocol, and the reviewability design.

## When this skill loads

The skill self-triggers from its description: it loads on research/plan/worktree/bug/qa/archive lifecycle events, Lavish review replies, and corpus-health requests, and stays out of routine code edits. Invoke `/agents-docs` explicitly to force a health pass - `report --check` before a big commit, `status` or `report --html` snapshots after a long session. The two paths are complementary: the narrow trigger catches workflow moments automatically; the slash command forces health passes on demand.

## 1. Frontmatter field reference (OKF v0.2)

`type` is the only required field. Everything else is recommended or optional, and custom keys are preserved - never rejected.

| Field | Role | Example |
|---|---|---|
| `type` | Required. Doc kind; consumers route on it. | `plan` |
| `title` | One-line title (defaults to the `# ` heading if absent). | `Serve Mastra serverless on Hono` |
| `description` | One-line summary; feeds `index.md`. | `Mount Mastra into the existing Hono/Bun API.` |
| `area` | Frontend/backend specialization axis. | `frontend` |
| `tags` | Freeform keywords. | `[monorepo, migration]` |
| `status` | Lifecycle; default `active`. | `deferred` |
| `priority` | Optional sort key. | `high` |
| `created` | First-write date (YYYY-MM-DD). | `2026-08-01` |
| `updated` | Last-touch date; drives staleness. | `2026-08-10` |
| `stale_after` | Freshness deadline (absolute date). Auto-set on `new`. | `2026-10-10` |
| `entry_point` | Boolean. True for docs that are intentionally unreferenced (e.g. coverage matrix, top-level plan). | `true` |
| `superseded_by` | Terminal docs point at the active successor. | `../plans/serverless-native.md` |
| `related` | Cross-doc references. | `[../research/mastra-versions.md]` |
| `visual` | Links this doc to its Lavish artifact (repo-root-relative). | `.lavish/foo.html` |
| `pre-existing` | Boolean, primarily for `bug`. True when the bug reproduces on the base branch and is unrelated to the current change. | `true` |
| `owning_branch` | Branch where the fix should land (e.g., `feat/inline-image-frontend`). Use `main` if the fix belongs on the default branch. | `feat/inline-image-frontend` |
| `batch` | Visual QA / verification batch name. Groups dossiers and the coverage matrix. | `inline-image-2026-08-12` |
| `feature_area` | Domain area being tested (used by /visual-qa), separate from the agents-docs `area` axis. | `inline-image` |
| `scenario` | Visual QA scenario slug. | `backend-only-chat-screen` |
| `tester` | Agent or person who ran the verification. | `claude` |
| `worktree` | QA worktree branch name used for the run. | `qa/inline-image-merged-2026-08-12` |
| `worktree_path` | Absolute path to the QA worktree, for traceability after removal. | `/home/user/repo/.worktrees/qa-inline-image-merged-2026-08-12` |
| `source_branches` | Branches merged into the QA worktree for this verification. | `[origin/feat/inline-image-backend, origin/feat/inline-image-frontend]` |
| `commits_verified` | Commits that were present in the QA worktree when verified. | `[feat/inline-image-backend@53439bb0]` |
| `sources` | Trust family: where the facts came from. Enforced for research docs: `archive --status complete` is refused while it is missing or empty. | `[url]` |
| `generated` | Trust family: generated output, with `by` and `at`. | `{by: claude, at: 2026-08-10}` |
| `verified` | Trust family: verification events, each with `by` and `at`. | `[{by: tuske, at: 2026-08-09}]` |
| `depends_on` | Stacked worktrees: list of upstream dependency docs. | `[../worktrees/backend-schema.md]` |
| `stack_position` | Stacked worktrees: integer 1-indexed position in sequential stack. | `2` |
| `stack_batch` | Stacked worktrees: batch identifier grouping stacked layers. | `2026-02-auth-overhaul` |
| `okf_version` | Reserved for `index.md` only. | `"0.2"` |

Status values:

| Type | Active statuses | Terminal (archivable) | Notes |
|---|---|---|---|
| research | `active` | `complete`, `dead-end` | complete links to its plan via `superseded_by` |
| plan | `active`, `deferred` | `complete`, `dropped` | deferred stays in `plans/`, never archived while deferred |
| worktree | `active` | `landed`, `abandoned` | landed links the branch commit + dossiers; use after worker_done but before the actual git merge |
| bug | `open` | `fixed`, `wontfix` | a regression files a NEW bug, never un-archives; use `pre-existing: true` for bugs that reproduce on the base branch |
| coverage | `active` | `retired` | retired when the covered surface disappears |
| dossier | `verified` | `retired` | retired when its matrix retires |

`abandon` defaults per type:

| Type | Default abandon status |
|---|---|
| research | `dead-end` |
| plan | `dropped` |
| worktree | `abandoned` |
| bug | `wontfix` |
| coverage | `retired` |
| dossier | `retired` |

Stale windows (days without `updated` before an active doc is flagged as stale):

| Type | Stale window | Notes |
|---|---|---|
| worktree | 14 | worktrees should move fast or be archived |
| research | 30 | exploration goes cold quickly without new facts |
| bug | 30 | bugs should resolve or be explicitly wontfix |
| plan | 60 | plans rot when not moving |
| coverage | 90 | coverage matrices are stable reference docs |
| dossier | 180 | verification evidence falls back to the global default |

`new` writes `stale_after = today + stale_window`. Docs without `stale_after` use the type window for stale checks.

## 2. Per-type templates

All docs share the frontmatter contract above. The one-line summary under `# <title>` is the description of the doc.

**research** - what the options are and what was learned.

```
# <title>

## Question
## Summary of findings          # table: # | Finding | Relevance | Confidence | Evidence
                                 #       |---|---------|-----------|------------|----------
## Options considered
## Findings
## Recommendation / decision
## Sources
```

The Summary-of-findings table ranks findings by relevance x confidence.
Relevance (ACH vocabulary): `critical` = a decision depends on it, `normal`, `trivial`.
Confidence (GRADE / ICD 203 vocabulary): `high` = primary source or executed command, `medium` = secondary source, `low` = unverified.
Evidence: a URL, `verified-by: <command>`, `local:<path>`, or `none`.
The table is enforced by the evidence gate - see Evidence validation below.

**plan** - actionable steps toward a committed outcome.

```
# <title>

## Goal capsule
## Current state (grounded)
## Target state
## Key technical decisions     # table: ID | Decision | Rationale
## Tools / MCP / Skills        # native tools, MCP servers, and agent skills the plan relies on
## Worktree Strategy           # single worktree or parallel tracks: branch, area, objective, tasks, verification
## Risks / open questions      # checked off as they resolve
## Related
```

**worktree** - a scoped working branch, tied to a plan.

```
# <title>

## Goal
## Branch
## Tools / MCP / Skills       # native tools, MCP servers, and agent skills used
## Tasks                       # checklist
## Verification               # links to qa/ dossiers
## Open questions
```

**bug** - an incident, filed against the live product.

```
# <title>

## Repro                    # how an end-user would hit it
## Root cause
## Fix                      # commit
## Verification            # dossier link
## Regression check
```

**coverage matrix** (`qa/*.md`) - the surface map.

```
# <title>

## Coverage scope
## Items                     # table: item | dossier | status
## Out of scope
```

**dossier** (`qa/verification/**`) - one proof-of-verification per item.

```
# <title>

## Scenario
## Steps
## Evidence
## Acceptance criteria
## Limitations
```

## 3. Folder lifecycle mechanics

Per-folder archive vs prune triggers.
The auto model: "is done?" is semantic (declared by you in conversation or in the doc's frontmatter) - the sweep never guesses.
"Move the done doc" is mechanical and fully automatic.
Three automatic rules + one advisory:

1. **auto-archive** - an active doc whose status is terminal for its `type`, or that carries a `superseded_by`, moves to `archive/` on the next sweep. Destination is flat `archive/<type>-<basename>.md` to prevent collisions between research, plan, and worktree docs of the same title.
2. **auto-prune** - an archive doc that is superseded AND past the TTL (default 180d) AND unreferenced may be GC'd. If still referenced from a live doc it is refused with the linker names; `--force` overrides.
3. **auto-cadence** - the sweep runs at the end of every lifecycle command (`new`, `visual`, `sync`, `archive`, `abandon`, `revive`, `scaffold-worktrees`, `ensure --apply`) and before review gates on skill load.
4. **(advisory)** - active docs older than their type's stale window with no terminal status and no `stale_after` are surfaced as "declare live or dead" - the one manual line. Stable evidence is a legitimate state; the sweep never auto-archives it. `new` writes a `stale_after` so the advisory usually fires only for docs created before this convention or for docs whose clock has genuinely run out.

| Folder | Archives when | Prunes (GC) when |
|---|---|---|
| `research/` | concluded - promoted to a plan or dead-end. Set `status: complete` (+ `superseded_by` if promoted) and move to `archive/research-*.md` | in archive, superseded + past TTL |
| `plans/` | `complete` (full execution, links to verification) or `dropped` / `deferred`. Moves to `archive/plan-*.md` | deferred past a max-defer window -> mark abandoned, archive, then GC |
| `worktrees/` | `landed` (link branch commit + dossiers) or `abandoned`. Moves to `archive/worktree-*.md` | landed/abandoned worktrees are the prime GC candidates |
| `bugs/` | `fixed` (link fix commit + dossier) or `wontfix`. Moves to `archive/bug-*.md` | fixed bugs past TTL |
| `qa/` | coverage matrix retired when the surface disappears; dossiers retired when `stale_after` passes or their matrix retires | evidence is longest-retained; GC only well past TTL |
| `archive/` | - | the only folder that ever deletes - superseded AND past TTL; `log.md` keeps a trace line |

Two terminal states; nothing is hard-deleted directly.

1. **`archive/`** is checkpoint + history. Every clearly-done doc moves here as `archive/<type>-<name>.md`, and the move is always reversible via `revive` (git is the version history). This is the normal terminal state.
2. **`prune --gc`** (or `clean` with `--gc`) is archive garbage collection - the only delete path. Removes archive docs that are *both* superseded *and* older than the retention window *and* unreferenced. Opt-in, `--dry-run` first, TTL configurable. Reference guard refuses with linker names; `--force` overrides.

Lifecycle model: `bugs/` is an incident side-channel.
The build pipeline flows `research -> plan -> worktree -> qa -> archive`.
A bug is discovered against the live product at any time and enters from the side (`open -> fixed/wontfix -> archive`), touching the pipeline only at `qa/` (verification) and `archive/`.

Provenance: an archive doc's source folder is recoverable from its filename prefix (`archive/bug-*.md` -> `bugs/`, `archive/plan-*.md` -> `plans/`, etc.) and via `status --show-archive` / `report --show-archive`, which group archive rows by source folder.

## 4. `docs.js` subcommand reference

Run with `bun .agents/skills/agents-docs/scripts/docs.js <command>`.

`AGENTS_DOCS_ROOT` overrides the corpus location (used by tests).

| Subcommand | Does |
|---|---|
| `new <type> <title> [--area <a>]` | Create a doc from the type template; fail if the target exists. Registers in the index. |
| `scaffold-worktrees <plan-doc>` | Parse the `## Worktree Strategy` section from a plan and generate `worktrees/<area>-<slug>.md` flight logs. |
| `ensure [--dry-run] [--apply]` | Converge the tree to the 6-folder structure: folder moves, area-prefix renames, date-prefix drops, frontmatter conformance (adds missing, never overwrites), link normalization through the move map, empty-folder removal. Dry-run by default. Flags decisions it will not make. |
| `lookup <artifact>` | Reverse-map a Lavish artifact path to its source doc(s) via the `visual:` key. |
| `visual <doc> <artifact>` | Register/update the `visual:` frontmatter key. Warns if the artifact is not under `.lavish/` (not commit-safe). |
| `sync <artifact> [--message "..."]` | Post-feedback bookkeeping: bump `updated`, append `log.md`, regenerate `index.md`. |
| `status [--show-archive] [--show-orphan]` | List every doc by folder x area x status; flag stale and orphan. Archive collapses to one summary line; `--show-archive` expands with `!not-terminal` flags. Orphans are summarized by default; `--show-orphan` expands the per-row flag. |
| `report [--html [--out <path>]] [--check] [--show-archive] [--show-orphan]` | Sortable corpus health dashboard. `--html` writes a standalone page (default `.lavish/docs-report.html`); `--check` exits non-zero on stale / dangling / nonconformant (archive docs never gate). `--show-archive` / `--show-orphan` expand collapsed sections. |
| `index` | Regenerate `index.md` from frontmatter (catalog grouped by folder x status). |
| `clean [--dry-run] [--apply] [--stale-orphan] [--force] [--ttl <days>]` | Auto-archive terminal/superseded docs and GC unreferenced archive docs (the sweep). Dry-run previews; default applies. `--stale-orphan` archives stale+unreferenced docs (dry-run by default, requires `--apply`). Also runs automatically at the end of lifecycle commands. |
| `prune [--dry-run] [--apply] [--gc] [--ttl <days>] [--force]` | Explicit, batched version of `clean`. Propose archiving for terminal / superseded docs, or GC archive docs that are superseded AND past the TTL (default 180 days). Referenced archive docs refused with linker names; `--force` overrides. |
| `archive <doc> [--status=<terminal>] [--dry-run]` | Move to `archive/<type>-<basename>.md`, set terminal status, rewrite inbound + outbound links file-relative, append `log.md`, regen index. `--dry-run` prints the planned archive without moving files. Research docs: `--status complete` is refused while critical evidence flags are unresolved (see Evidence validation). |
| `revive <archive-doc>` | Move from `archive/<type>-<name>.md` back to active home folder with `status: active` (or `open`), reset staleness deadline, rewrite links, regen index. |
| `abandon <doc> [--status=<terminal>] [--dry-run]` | One-step archive with the type's default terminal status. Use when a doc is left behind without a full review. |

### Health badges (`report`)

All computed from frontmatter + the link graph - never declared by the LLM, so they cannot drift:

- `stale` - `updated` older than the type's stale window (or `stale_after` passed) for an active doc.
- `dangling` - an outbound link resolves to a path that does not exist.
- `nonconformant` - missing required `type` (archive docs exempt - historical).
- `orphan` - zero inbound links. Advisory only; `entry_point: true` docs are excluded from orphan counts. `--show-orphan` surfaces the flag.
- `not-terminal` - an archived doc reads with an unknown or active status (e.g. `active`, `done`). Anomaly only - surfaces via `status`/`report` and `--show-archive`, never fails `--check`. Fix by setting a terminal status.

### Evidence validation (`evidence.js`)

`scripts/evidence.js` runs rule-based evidence checks on research docs - first-layer protection against unsourced or hallucinated claims.
It is language-agnostic and structural: it verifies that evidence slots are filled, not the evidence content.
Ecosystem-specific verification (dependency metadata commands like `npm view`, capability probes) is authoring guidance in SKILL.md, not script code.

Rules:

| Rule | Severity | Fires when |
|---|---|---|
| `sources-section` | critical | the doc has no non-empty `## Summary of findings` or `## Sources` section |
| `negative-claim` | critical | a prose paragraph makes a negative existence claim about an external product ("no documented X", "does not support Y", "cannot") without a URL or `verified-by:` command in the same paragraph |
| `sources-frontmatter` | critical | frontmatter `sources:` is missing or empty |
| `critical-low-confidence` | critical | a critical-relevance Summary-of-findings row is marked low confidence |
| `finding-evidence` | critical / warning | a Summary-of-findings row has no usable evidence (expected a URL, `verified-by:`, or `local:`); warning for non-critical rows |

Fenced code blocks, HTML comments, and table rows are excluded from the negative-claim scan; table rows are covered by the Summary-of-findings rules instead.

Usage:

```bash
bun .agents/skills/agents-docs/scripts/evidence.js <doc-ref...>   # check specific research docs
bun .agents/skills/agents-docs/scripts/evidence.js --all          # every research doc (active + archive)
bun .agents/skills/agents-docs/scripts/evidence.js --all --json   # machine-readable output
```

Exit code is 1 when any checked doc has a critical flag, 0 otherwise.
`docs.js archive <doc> --status complete` runs the same checks as a gate: it prints the blocking flags and refuses the move.
Resolve the flags (add sources, verify or downgrade the finding, or archive as `dead-end` instead) and retry.

## 5. Lavish integration protocol

Lavish review sessions use the [`lavish-axi`](https://github.com/kunchenguid/lavish-axi) CLI tool (run on demand with `npx -y lavish-axi <html-file>` or install globally via `npm install -g lavish-axi`).
`.lavish/` is gitignored, so the HTML artifact is a throwaway mirror.
The only durable record is the markdown doc.
On every Lavish reply, **sync docs first, then edit the HTML**.

1. **On open** - before `lavish-axi <artifact>` (or `npx -y lavish-axi <artifact>`), ensure the artifact reflects the current doc state and register `visual:` if missing.
2. **On feedback** (poll returns) - parse the prompt, update the mirrored doc(s): status, criteria, decisions. Append `log.md` and bump `updated` (`sync` does the mechanical part). Then edit the HTML to match.
3. **Re-poll** with `lavish-axi poll <file> --agent-reply "<message>"` (or `npx -y lavish-axi poll ...`) - foreground, never kill.
4. **`Send & End`** - final feedback is synced once, then the session stays closed. Deliver any remaining updates in-conversation; never reopen uninvited.

Session keys are artifact file paths, so `lookup` reverse-maps an artifact to its doc in one step - docs stay self-describing.

### Decision checkpoints - when Lavish opens

Lavish opens an interactive session only at three decision gates, where blocking for the human is the point:

1. **Plan approval** - an `active` plan is ready to execute; the user reviews before it becomes the dispatch contract.
2. **Dry-run / migration map review** - a big structural change (e.g. `ensure --dry-run`) is reviewed as a rename/move map before applying.
3. **Worktree dispatch sign-off** - the scope of parallel frontend/backend worktrees is confirmed before execution.

Everywhere else Lavish stays manual; `/lavish` is the always-available escape hatch. Never open an interactive session on routine updates.

### Reply scaling

Match the reply to the change magnitude:

| Change | Reply |
|---|---|
| small (a doc, a dossier) | plain text, no artifact |
| big, no decision pending | passive dashboard - `report --html`, point at `.lavish/docs-report.html` |
| big, decision pending | interactive Lavish on the plan artifact, halt and wait for the reply |

Docs-first applies at every scale: sync the doc before editing the HTML.

### Parallel-execution handoff

agents-docs owns the seam to parallel work and never reimplements orchestration. An approved plan doc is the contract handed to the orchestration skill (`worktrunk-orca-delegation`). Each worktree gets a `worktrees/` doc tracking `branch -> active -> landed`; landed worktrees archive with dossier links; bugs found mid-execution enter `bugs/` from the side. The plan doc therefore carries tasks + verification criteria that worktree docs and qa/ dossiers reference.

## 6. Reviewability design (flat authoring, generated views)

Authoring is flat markdown the LLM edits; every human-facing view is generated from it, so it can never drift out of sync with the files.

1. **`index.md`** - the catalog (progressive disclosure). Grouped by folder x status; regenerated by `index`. The "what exists here" entry point.
2. **`report --html`** - the status dashboard, the *git status of the corpus*. Every doc with sortable columns - filename, type, area, status, priority, created, updated, health badges, inbound link count.
3. **`report --check`** - the CI gate. Exits non-zero when anything is stale, dangling, or nonconformant. A passing check is the contract that the corpus is inspectable.

Deprecated and unused docs surface *without* the LLM having to mark them, because stale and orphan are computed, not declared. Re-running any command re-derives ground truth from the actual files, so a human can always see what the LLM has drifted on.