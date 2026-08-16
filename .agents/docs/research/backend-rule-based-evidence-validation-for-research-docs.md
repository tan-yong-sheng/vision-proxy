---
type: research
title: rule-based evidence validation for research docs
description: "Design for a rule-based evidence-validation layer that flags unsourced claims in research docs before they can reach status: complete."
area: backend
tags: [agents-docs, evidence, validation, hallucination-prevention, grade, icd-203, ach]
status: active
created: "2026-08-16"
updated: "2026-08-16"
stale_after: "2026-09-15"
sources: [url, local]
related:
  - ../archive/research-backend-hook-based-tool-interception-for-vision-proxy.md
  - ../archive/research-backend-support-vercel-ai-sdk-harness-adapters.md
  - ../archive/research-backend-binary-as-hook-vision-proxy-integration.md
  - ../plans/backend-evidence-validation-mvp-for-agents-docs.md
---
# rule-based evidence validation for research docs

## Question

Can a cheap, rule-based pre-check (no LLM) raise the validity of `.agents/docs/research/` docs - catching hallucinated or unsourced claims before they drive implementation - and signal to the agent when deeper research is needed?

## Summary of findings

| # | Finding | Relevance | Confidence | Evidence |
|---|---------|-----------|------------|----------|
| 1 | Three audited research docs that drove real implementation contain zero URLs and no `## Sources` section, despite the template requiring one. Two shipped wrong conclusions. | critical | high | local:../archive/research-backend-hook-based-tool-interception-for-vision-proxy.md, local:../archive/research-backend-support-vercel-ai-sdk-harness-adapters.md, local:../archive/research-backend-binary-as-hook-vision-proxy-integration.md |
| 2 | Claude Code documents a `PreToolUse` hook ("Before a tool call executes. Can block it."), contradicting the archived hook-interception research claim that no such hook exists. | critical | high | https://docs.anthropic.com/en/docs/claude-code/hooks |
| 3 | `@mcpc-tech/acp-ai-provider` depends on `ai: ^6.0.0` and its README states "v0.2.x requires AI SDK v6", incompatible with this project's `ai@7`. The mismatch was never checked before implementation. | critical | high | https://www.npmjs.com/package/@mcpc-tech/acp-ai-provider |
| 4 | The OKF schema already defines a `sources` frontmatter trust-family field, but `docs.js` never reads or validates it; docs reach `status: complete` with no evidence recorded. | critical | high | local:../skills/agents-docs/REFERENCE.md (field table), local:../skills/agents-docs/scripts/docs.js |
| 5 | GRADE (Cochrane) rates certainty of evidence high/moderate/low/very low and opens every review with a "Summary of findings" table. | normal | high | https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-14 |
| 6 | ICD 203 mandates confidence levels in analytic products and requires distinguishing underlying source information from analyst judgment. | normal | high | https://www.intelligence.gov/assets/documents/intelligence-community-directives/ICD_203.pdf |
| 7 | ACH (Heuer) rates each evidence item for credibility and relevance (high/medium/low) before weighing hypotheses. | normal | high | https://en.wikipedia.org/wiki/Analysis_of_competing_hypotheses |
| 8 | `docs.js` is 1835 lines / 64 functions in a single file. | normal | high | verified-by: wc -l .agents/skills/agents-docs/scripts/docs.js |

## Options considered

1. **Rule-based script only** - all checks hard-coded in a script. Rejected for ecosystem-specific checks: an `npm view` check does not generalize when the skill is used on Go, Rust, or C++ projects.
2. **SKILL.md guidance only** - instruct the agent to cite sources, no script. Rejected: the three audited docs prove guidance alone is not followed.
3. **Hybrid (chosen)** - language-agnostic structural checks in a script; ecosystem-specific evidence gathering (dependency metadata commands, capability probes) as SKILL.md guidance, with the script verifying the evidence slots are filled.
4. **LLM-judge validation** - a second model scores claim-evidence alignment. Deferred to an optional later pass: higher cost, non-deterministic, and unnecessary for the failure modes observed.

## Findings

### Failure modes observed in this corpus

- **A - Negative-claim hallucination.** The hook-interception research claimed "no documented PreToolUse hook in the public Claude Code hook API" with zero sources. The official hooks reference documents PreToolUse (finding 2). Negative existence claims about external products are a high-risk hallucination class.
- **B - Version incompatibility.** The ACP plan never checked the provider's dependency range; `ai@^6` vs project `ai@7` was discoverable with one metadata command (finding 3).
- **C - Provenance misclassification.** A community package was framed as Vercel-supported based on a community-provider docs listing.
- **D - Core capability unverified.** Whether the provider transmits image `FilePart`s (the entire use case) was only tested after merge, via a fake-agent probe.

### Design decisions (reviewed and approved via Lavish artifact `.lavish/research-evidence-validation.html`)

- **Scope:** build the MVP - 3 script rules + 1 SKILL.md guidance rule.
- **Enforcement:** block transition to `status: complete` while critical flags are unresolved.
- **Location:** split `docs.js` shared internals into `scripts/lib/*.js` with zero behavior change, then add `scripts/evidence.js` importing the shared lib.
- **Doc format:** research docs open with a GRADE-style "Summary of findings" table (`| # | Finding | Relevance | Confidence | Evidence |`), full-word values, per ACH relevance x GRADE/ICD-203 confidence.
- **Risk-proportional evidence:** critical + low-confidence rows hard-block completion; critical + high-confidence rows require a URL or `verified-by:` command; normal/trivial rows are flagged non-blocking; repo-local facts and reasoning use `local:<path>` evidence or stay out of the table.

### MVP rule set

Script rules (language-agnostic):

1. Research docs must contain a non-empty Summary of findings / Sources section.
2. Negative-claim detector: paragraphs matching `/\b(there is no|no documented|does not support|doesn't support|not supported|not exposed|cannot|can't|unsupported|no way to|not possible)\b/i` about external products must contain a URL or a `verified-by:` marker in the same paragraph.
3. `sources:` frontmatter must be non-empty before `status: complete`; critical + low-confidence Summary-of-findings rows block completion.

Guidance rule (SKILL.md, any ecosystem):

4. Dependency research must record compatibility evidence via the ecosystem-appropriate metadata command (`npm view` / `cargo info` / `go list -m` / ...) plus an `official`/`community` label; the script checks the slot is filled, not the content.

### What layer 1 cannot catch

Semantic claim-evidence alignment, completeness of options, gamed citations, and runtime capability (failure D) all still need the agent, a probe, or a human. The script emits a structured risk signal; it does not issue verdicts.

## Recommendation / decision

Build the MVP as scoped above. Built-in regression test: the three archived docs in findings 1 must all fail the new gate.

## Sources

- https://docs.anthropic.com/en/docs/claude-code/hooks - Claude Code hooks reference; documents PreToolUse.
- https://www.npmjs.com/package/@mcpc-tech/acp-ai-provider - dependency metadata and version-compatibility README note.
- https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-14 - GRADE certainty ratings and Summary of findings tables.
- https://www.intelligence.gov/assets/documents/intelligence-community-directives/ICD_203.pdf - analytic standards: confidence levels, source-vs-judgment separation.
- https://en.wikipedia.org/wiki/Analysis_of_competing_hypotheses - ACH credibility/relevance evidence ratings.
