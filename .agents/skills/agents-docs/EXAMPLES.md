# agents-docs EXAMPLES

Worked lifecycle examples. Each example is a full, real sequence you can follow.

## 1. Lifecycle: research -> plan -> Lavish review -> complete -> archive

**1. Create a research doc.** The user asks to evaluate a model-list provider strategy.

```bash
bun docs.js new research "Server-driven model list" --area backend
```

Creates `research/backend-server-driven-model-list.md` with the research template and a `description` placeholder.

**2. Fill the research, reach a decision.** Edit the doc: options compared, recommendation chosen, set `status: complete`. Regenerate the index afterward.

**3. Promote to a plan.** Create the commit-to-do:

```bash
bun docs.js new plan "Server-driven model list" --area backend
```

Link the research under `related`, then mark the research doc as born-into-archive:

```bash
bun docs.js archive research/backend-server-driven-model-list.md --status complete
```

The script moves it to `archive/`, rewrites inbound links, appends `log.md`, and regenerates the index. `superseded_by` on the research doc points at the plan.

**4. Visualize the plan in Lavish.**

```bash
bun docs.js visual plans/backend-server-driven-model-list.md .lavish/model-list-plan.html
lavish-axi .lavish/model-list-plan.html          # open the artifact
lavish-axi poll .lavish/model-list-plan.html     # long-poll for feedback
```

**5. Feedback loop - docs first.** The user annotates: "the fallback ordering is wrong, swap B and C". Apply the chain:

```bash
# 1. Update the markdown (decisions, status, criteria).
#    edit plans/backend-server-driven-model-list.md ...
# 2. Mechanical bookkeeping.
bun docs.js sync .lavish/model-list-plan.html --message "swap fallback ordering B/C"
# 3. Edit the HTML to reflect the change, then re-poll.
lavish-axi poll .lavish/model-list-plan.html --agent-reply "swapped B and C in the fallback ordering"
```

`sync` bumps `updated`, appends `log.md`, and regenerates the index.
The doc is authoritative; the HTML is a throwaway mirror.

**3b. Scaffold worktrees for execution.** When the plan is ready for implementation, scaffold its worktrees in one step:

```bash
bun docs.js scaffold-worktrees plans/backend-server-driven-model-list.md
# parses ## Worktree Strategy and creates worktrees/backend-model-list.md
```

**6. Execute, then complete.** When the plan ships, link the verification and set the terminal state:

```bash
# add a qa/ verification dossier, link it in the plan
bun docs.js archive plans/backend-server-driven-model-list.md --status complete
# moves to archive/plan-backend-server-driven-model-list.md
```

**6b. Revive if needed.** If a feature or research needs to be reopened:

```bash
bun docs.js revive archive/plan-backend-server-driven-model-list.md
# moves back to plans/backend-server-driven-model-list.md with status: active
```

**7. Prune later.** When the archive fills, run the GC proposal:

```bash
bun docs.js prune --gc --dry-run   # review what would be deleted
bun docs.js prune --gc             # apply after review
```

Only archive docs that are superseded AND past the TTL are ever deleted, and `log.md` keeps a one-line trace.

## 1b. Auto-archive / auto-prune (the sweep)

The sweep is mechanical and runs automatically at the end of every lifecycle command (`new`, `visual`, `sync`, `archive`, `abandon`, `revive`, `scaffold-worktrees`, `ensure --apply`).
You declare "done" in frontmatter; the script moves the file.

```bash
# 1. Mark a plan complete (semantic decision is yours).
#    edit plans/backend-serverless-native.md -> status: complete

# 2. Any lifecycle command triggers the sweep; the done plan moves itself.
bun docs.js new plan "Something new" --area backend
#   ... archived plans/backend-serverless-native.md -> archive/plan-backend-serverless-native.md

# 3. Run the sweep explicitly (no lifecycle command needed).
bun docs.js clean --dry-run   # preview: would auto-archive <rel> (status complete)
bun docs.js clean             # apply

# 4. GC a superseded archive doc once it is past TTL and unreferenced.
bun docs.js clean --ttl 180   # archive doc superseded + >180d + unreferenced -> deleted
```

Guard rails the sweep enforces (all loud, never silent):

- **Collision** - move lands at `archive/<type>-<basename>.md`. If that target already exists, the auto-archived doc is skipped with `auto-archive-skip` and the sweep continues; the live copy is left in place for you to resolve.
- **GC reference guard** - an archive doc still linked from a live doc is refused with `gc-refused <rel> (still referenced by <linker>)`; pass `--force` to override (leaves the live doc with a dangling link).
- **Anomaly** - an archived doc that reads as `active`/`done` surfaces as `!not-terminal <rel>`. Fix by setting a terminal status; the gate (`--check`) still passes.
- **Stale advisory** - an active doc older than 180d with no terminal status is surfaced as "declare live or dead". It is never auto-archived; stable evidence stays put until you decide.

## 2. Feedback -> sync -> re-poll cycle (minimal, copy-paste)

The tight loop for any Lavish review of a single doc.

```bash
# register the artifact against the doc
bun docs.js visual plans/fullstack-agents-docs-skill.md .lavish/skill-plan.html

# poll (foreground)
lavish-axi poll .lavish/skill-plan.html
#   feedback: "add a reviewability section"
# edit plans/fullstack-agents-docs-skill.md ...

bun docs.js sync .lavish/skill-plan.html --message "add reviewability section"
# edit the HTML to match
lavish-axi poll .lavish/skill-plan.html --agent-reply "added the reviewability section"
```

On `Send & End`, sync once more, then close.
Never reopen the session uninvited.

## 3. Correcting a wrong file structure

A doc lands in the wrong folder or with a missing prefix.
Fix it by hand, then let the script do the bookkeeping:

```bash
mv research/foo.md research/frontend-foo.md
bun docs.js index                    # regenerate the catalog
bun docs.js status                   # confirm area/type read correctly
bun docs.js report --check           # confirm the corpus still gates
```

## 4. The migration (fresh corpus, one-time)

```bash
bun docs.js ensure --dry-run   # review the full plan: renames, moves, conformance, link rewrites
bun docs.js ensure --apply     # converge the tree to 6 folders
bun docs.js report --check     # gate: exits non-zero on stale/dangling/nonconformant
```

`ensure --apply` never deletes and never overwrites an existing frontmatter field.
If it prints `cannot infer type - manual`, set `type` by hand.
If the report flags `dangling`, fix the reference and re-run until clean - that is the contract.

## 5. Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `new` says the target exists | name collision | reuse the doc, or pick a distinct title |
| `sync` says no doc maps to the artifact | `visual:` not registered | `visual <doc> <artifact>` |
| `report --check` exit 1, `dangling` | link target path does not exist | fix or remove the reference |
| `report --check` exit 1, `nonconformant` | doc missing `type` | set `type` in frontmatter |
| `ensure` reports `archived/ and archive/ both exist` | migration hit a collision | merge the folders by hand, re-run |
| a doc is flagged `orphan` | nothing references it | advisory only - entry points are legitimately unreferenced; decide whether to add a link back or archive it |
| `archive` says `target exists - archive/<type>-<name>.md` | the type-prefixed filename already lives in `archive/` | decide which copy is canonical, remove the other, retry |
| `clean` says `auto-archive-skip: target exists` | collision during auto sweep | the live copy was left in place; resolve the collision by hand, then re-run `clean` |
| `clean` says `!not-terminal archive/<doc>` | archived doc reads with unknown/active status | set a terminal status so the archive health reads `ok` |
| `clean` says `gc-refused <doc> (still referenced by <linker>)` | archive doc is still evidence for a live doc | update the linker to point elsewhere, or pass `--force` to override (leaves a dangling link) |

## 6. Parallel worktree handoff and reply scaling

The corpus is the contract behind parallel frontend/backend work.
This example follows a plan from sign-off through dispatch to archive, and the reply scaling at each step.

**1. Hand the approved plan to orchestration.**
A plan doc that is `active`, with tasks and verification criteria, is the dispatch contract.
It is handed to the orchestration skill (`worktrunk-orca-delegation`) - agents-docs owns the seam, not the dispatcher.

**2. Sign-off gate (interactive).**
Scope for the parallel worktrees is confirmed at a decision checkpoint:

```bash
bun docs.js sync plans/frontend-rn-parity-gaps-worktree.md --message "dispatch scope signed off"
# render the plan artifact, open it, halt for the reply
lavish-axi poll .lavish/plan.html --agent-reply "scope confirmed - dispatching frontend and backend worktrees"
```

**3. Worktree docs scaffolded from plan.**

```bash
bun docs.js scaffold-worktrees plans/frontend-rn-parity-gaps-worktree.md
# Creates worktrees/frontend-rn-parity-gaps-frontend.md and worktrees/backend-rn-parity-gaps-backend.md
```

Each tracks `branch -> active -> landed`; a bug found mid-execution is filed with `new bug` and enters from the side.

**4. Merge, verify, archive.**
When the worktrees land, link the branch commit and dossiers, set `status: landed`, then archive:

```bash
bun docs.js archive worktrees/frontend-rn-parity-gaps-frontend.md --status landed
# Moves to archive/worktree-frontend-rn-parity-gaps-frontend.md
```

**5. Big-change reply (passive).**
If the change is large but no decision is pending, reply with the passive dashboard instead of opening a session:

```bash
bun docs.js report --html
```

`.lavish/docs-report.html` shows corpus health - stale/orphan/dangling/nonconformant, sortable - at a glance with no interaction required.
Only when a decision is pending does the agent open an interactive Lavish session and halt.
Never both, never on every message.