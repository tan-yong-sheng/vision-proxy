---
type: plan
title: evidence validation MVP for agents-docs
description: "Split docs.js into scripts/lib/ + add scripts/evidence.js with 3 rule-based checks; update SKILL.md/REFERENCE.md with the Summary-of-findings format and dependency-evidence guidance."
area: backend
tags: [agents-docs, evidence, validation, refactor]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-10-15"
related:
  - ../archive/research-backend-rule-based-evidence-validation-for-research-docs.md
---
# evidence validation MVP for agents-docs

## Goal capsule

Add a rule-based evidence-validation layer to the agents-docs skill so research docs with unsourced external claims cannot reach `status: complete` unnoticed. Language-agnostic checks live in a new `scripts/evidence.js`; ecosystem-specific evidence gathering becomes SKILL.md guidance.

## Current state (grounded)

- `scripts/docs.js` is a single 1835-line file with 64 functions: frontmatter parse/serialize, doc scanning, link graph, and all subcommands (`status`, `report`, `new`, `archive`, `index`, ...).
- The OKF schema (`REFERENCE.md`) defines a `sources` trust-family frontmatter field; nothing validates it.
- The research template has a `## Sources` section; the three audited archived research docs shipped without it and with zero URLs.
- Two of those docs drove implementations that had to be reversed (ACP provider removed; PreToolUse claim was wrong).

## Target state

1. `scripts/lib/` holds the shared internals extracted from `docs.js` (frontmatter parse/serialize, doc scan, markdown utilities) with zero behavior change to existing commands.
2. `scripts/evidence.js` runs the MVP rule set against research docs and prints structured flags (file, line, rule, excerpt).
3. `docs.js archive <research-doc> --status complete` refuses while critical evidence flags are unresolved.
4. `REFERENCE.md` research template gains a `## Summary of findings` table; `SKILL.md` gains the dependency-evidence guidance rule.
5. Regression check: the validator flags all three archived docs listed in the research doc.

## Key technical decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Split `docs.js` into `scripts/lib/` before adding the validator | 1835-line monolith; avoids duplicating the parser in a second script; zero behavior change |
| D2 | Validator is a separate `evidence.js` entry point importing the lib | Clean separation; `docs.js` keeps its command surface |
| D3 | Block only on `archive --status complete` for research docs | Approved enforcement point; active research stays unblocked |
| D4 | Risk-proportional rules: only critical-relevance rows hard-block | Avoids the too-strict failure mode; normal/trivial rows warn |
| D5 | Ecosystem-specific checks are SKILL.md guidance, not code | npm-specific scripts do not generalize to Go/Rust/C++ repos |
| D6 | Negative-claim detection is paragraph-level regex, not per-sentence | Per-sentence claim detection false-positives on opinion/reasoning |

## MVP rules (evidence.js)

1. **sources-section** - research docs must contain a non-empty `## Summary of findings` or `## Sources` section.
2. **negative-claim** - paragraphs matching the negative-existence-claim pattern about external products must contain a URL or `verified-by:` marker in the same paragraph.
3. **completion-gate** - `sources:` frontmatter must be non-empty before `status: complete`; Summary-of-findings rows with `critical` relevance and `low` confidence block completion.

## SKILL.md / REFERENCE.md changes

- Research template: add `## Summary of findings` table (`| # | Finding | Relevance | Confidence | Evidence |`) with a 3-line legend (relevance = ACH term; confidence = GRADE/ICD-203 term; evidence = URL | `verified-by: <command>` | `local:<path>` | `none`).
- Guidance: dependency research must record compatibility evidence via the ecosystem-appropriate metadata command plus an `official`/`community` label.
- Guidance: capability claims about libraries need a `## Verification` section with commands + outputs.

## Tools / MCP / Skills

- Native: bash, read, write, edit
- Skills: agents-docs (the skill being modified), review-gate (final gate)

## Worktree Strategy

Single worktree. Branch: `feat/research-evidence-validation` (already created; research + plan docs live on it).

Tasks:

- [x] Extract `scripts/lib/` (frontmatter, scanner, markdown utils) from `docs.js`; all existing commands pass unchanged
- [x] Add `scripts/evidence.js` with rules 1-3 and structured flag output
- [x] Wire the completion gate into `docs.js archive --status complete` for research docs
- [x] Update `REFERENCE.md` template + `SKILL.md` guidance
- [x] Regression: validator flags the 3 archived research docs; passes the new research doc

## Risks / open questions

- [ ] False positives on the negative-claim regex for prose about our own repo - mitigated by `local:` citations and rewording; monitor first week of use.
- [x] The split must be behavior-preserving; verify by running `status`, `report --check`, `index`, and `archive --help`-level smoke checks before and after. Verified: before/after output identical for status/status-full/report/clean/prune/report-html; only the intentional help-text addition differs.

## Related

- Research: ../research/backend-rule-based-evidence-validation-for-research-docs.md
