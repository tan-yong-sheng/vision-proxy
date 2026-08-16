#!/usr/bin/env bun
// agents-docs evidence - rule-based evidence validation for research docs.
//
// First-layer protection against unsourced or hallucinated claims. Language-
// agnostic structural checks only; ecosystem-specific evidence gathering
// (dependency metadata commands, capability probes) is SKILL.md guidance - this
// script verifies the evidence slots are filled, not the evidence content.
//
// Usage: bun evidence.js <doc-ref...>   check specific research docs
//        bun evidence.js --all          check every research doc (active + archive)
//        bun evidence.js --json ...     machine-readable output
//
// Exit code: 1 when any checked doc has a critical flag, 0 otherwise.
// docs.js imports completionBlockers() for the archive -> complete gate;
// the CLI only runs when this file is the entry point.
//
// AGENTS_DOCS_ROOT overrides the corpus location (used by tests).

import { scanDocs } from "./lib/corpus.js";
import { findDoc, die } from "./lib/util.js";

// Negative existence claims about external products are a high-risk
// hallucination class (observed: "no documented PreToolUse hook" - false).
// Paragraph-level, not sentence-level: per-sentence matching false-positives
// on opinion and reasoning.
const NEGATIVE_CLAIM_RE =
  /\b(there is no|there are no|no documented|does not support|doesn't support|do not support|not supported|not exposed|cannot|can't|unsupported|no way to|not possible)\b/i;

const URL_RE = /https?:\/\//i;
const VERIFIED_BY_RE = /verified-by:/i;

// ---------------------------------------------------------------------------
// Body segmentation (frontmatter-aware line numbers, code/table/comment skip)
// ---------------------------------------------------------------------------

function bodyWithLineOffset(text) {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      const bodyStart = end + 5; // matches readDoc's slice offset
      const lineOffset = text.slice(0, bodyStart).split("\n").length - 1;
      return { body: text.slice(bodyStart), lineOffset };
    }
  }
  return { body: text, lineOffset: 0 };
}

// Paragraphs of prose with their starting file line. Fenced code blocks, HTML
// comments, and table rows are excluded: code contains error-message prose that
// matches claim patterns, and table rows are validated by the Summary-of-
// findings rules which understand the Evidence column.
function proseParagraphs(text) {
  const { body, lineOffset } = bodyWithLineOffset(text);
  const lines = body.split("\n");
  const paragraphs = [];
  let cur = [];
  let curStart = 0;
  let inCode = false;
  let inComment = false;

  const flush = () => {
    const text = cur.join("\n").trim();
    if (text) paragraphs.push({ text, line: lineOffset + curStart + 1 });
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      flush();
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      flush();
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }
    if (trimmed.startsWith("|")) {
      flush();
      continue;
    }
    if (trimmed === "") {
      flush();
      continue;
    }
    if (cur.length === 0) curStart = i;
    cur.push(line);
  }
  flush();
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Summary of findings table parsing
// ---------------------------------------------------------------------------

const SOF_HEADING_RE = /^##\s+Summary of findings/i;
const SOURCES_HEADING_RE = /^##\s+Sources\b/i;

function sectionLines(text, headingRe) {
  const { body } = bodyWithLineOffset(text);
  const lines = body.split("\n");
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (headingRe.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line.trim())) break;
    if (inSection) out.push(line);
  }
  return out;
}

function hasEvidenceSection(text) {
  for (const re of [SOF_HEADING_RE, SOURCES_HEADING_RE]) {
    const lines = sectionLines(text, re);
    if (lines.some((l) => l.trim() !== "")) return true;
  }
  return false;
}

// Parse the Summary of findings table into rows keyed by header name.
// Single-line rows only; malformed rows are skipped (the table is agent-
// authored and the format check below reports a missing table instead).
function summaryOfFindingsRows(text) {
  const lines = sectionLines(text, SOF_HEADING_RE).filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return [];
  const splitRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const header = splitRow(lines[0]).map((h) => h.toLowerCase());
  const col = (name) => header.findIndex((h) => h === name);
  const idx = { finding: col("finding"), relevance: col("relevance"), confidence: col("confidence"), evidence: col("evidence") };
  if (idx.relevance === -1 || idx.confidence === -1 || idx.evidence === -1) return [];
  const rows = [];
  for (const l of lines.slice(1)) {
    if (/^\|[\s\-|]+\|$/.test(l.trim())) continue; // separator row
    const cells = splitRow(l);
    if (cells.length < header.length) continue;
    rows.push({
      finding: idx.finding === -1 ? "" : cells[idx.finding],
      relevance: (cells[idx.relevance] || "").toLowerCase(),
      confidence: (cells[idx.confidence] || "").toLowerCase(),
      evidence: cells[idx.evidence] || "",
      raw: l.trim(),
    });
  }
  return rows;
}

function evidenceCellFilled(evidence) {
  const e = evidence.trim().toLowerCase();
  if (e === "" || e === "none" || e === "-" || e.startsWith("none ")) return false;
  return URL_RE.test(e) || VERIFIED_BY_RE.test(e) || e.startsWith("local:");
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

// Every flag: { rule, severity: "critical" | "warning", line?, message, excerpt? }
// critical flags block a research doc from reaching status: complete.

export function evidenceFlags(doc) {
  if (doc.fm.type !== "research") return [];
  const flags = [];

  // Rule 1: sources-section - a research doc must carry a non-empty
  // Summary of findings or Sources section.
  if (!hasEvidenceSection(doc.text)) {
    flags.push({
      rule: "sources-section",
      severity: "critical",
      message: "research doc has no non-empty ## Summary of findings or ## Sources section",
    });
  }

  // Rule 2: negative-claim - negative existence claims about external
  // products need a URL or a verified-by: command in the same paragraph.
  for (const p of proseParagraphs(doc.text)) {
    if (!NEGATIVE_CLAIM_RE.test(p.text)) continue;
    if (URL_RE.test(p.text) || VERIFIED_BY_RE.test(p.text)) continue;
    flags.push({
      rule: "negative-claim",
      severity: "critical",
      line: p.line,
      message: "negative claim about an external product without a source URL or verified-by: command",
      excerpt: p.text.length > 120 ? p.text.slice(0, 117) + "..." : p.text,
    });
  }

  // Rule 3a: sources-frontmatter - the OKF trust-family field must be filled.
  const sources = doc.fm.sources;
  const sourcesFilled =
    (Array.isArray(sources) && sources.length > 0) || (typeof sources === "string" && sources.trim() !== "");
  if (!sourcesFilled) {
    flags.push({
      rule: "sources-frontmatter",
      severity: "critical",
      message: "frontmatter `sources:` is missing or empty (e.g. sources: [url], [local], [command])",
    });
  }

  // Rule 3b/3c: Summary-of-findings rows are risk-proportional. Critical
  // relevance rows must not sit at low confidence and must carry evidence;
  // normal/trivial rows with missing evidence only warn.
  for (const row of summaryOfFindingsRows(doc.text)) {
    const critical = row.relevance === "critical";
    const filled = evidenceCellFilled(row.evidence);
    if (critical && row.confidence === "low") {
      flags.push({
        rule: "critical-low-confidence",
        severity: "critical",
        message: "critical-relevance finding is marked low confidence - verify it, downgrade it, or drop it",
        excerpt: row.finding || row.raw,
      });
    }
    if (!filled) {
      flags.push({
        rule: "finding-evidence",
        severity: critical ? "critical" : "warning",
        message: `finding row has no usable evidence (expected a URL, verified-by:, or local:)`,
        excerpt: row.finding || row.raw,
      });
    }
  }

  return flags;
}

// Flags that block a research doc from reaching status: complete.
export function completionBlockers(doc) {
  return evidenceFlags(doc).filter((f) => f.severity === "critical");
}

export function formatFlag(f) {
  const where = f.line ? `:${f.line}` : "";
  const excerpt = f.excerpt ? ` - "${f.excerpt}"` : "";
  return `[${f.rule}] ${f.severity}${where}: ${f.message}${excerpt}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isResearchDoc(d) {
  return d.fm.type === "research";
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const refs = args.filter((a) => !a.startsWith("--"));
  if (!all && refs.length === 0) {
    die("usage: evidence.js <doc-ref...> | --all [--json]", 2, "evidence.js");
  }
  const docs = scanDocs();
  const targets = all ? docs.filter(isResearchDoc) : refs.map((r) => findDoc(docs, r));
  const results = [];
  let criticalCount = 0;
  for (const doc of targets) {
    if (!isResearchDoc(doc)) {
      results.push({ rel: doc.rel, skipped: "not a research doc", flags: [] });
      continue;
    }
    const flags = evidenceFlags(doc);
    criticalCount += flags.filter((f) => f.severity === "critical").length;
    results.push({ rel: doc.rel, flags });
  }
  if (json) {
    console.log(JSON.stringify({ docs: results, critical: criticalCount }, null, 2));
  } else {
    for (const r of results) {
      if (r.skipped) {
        console.log(`${r.rel}: skipped (${r.skipped})`);
        continue;
      }
      if (r.flags.length === 0) {
        console.log(`${r.rel}: ok`);
        continue;
      }
      console.log(`${r.rel}:`);
      for (const f of r.flags) console.log(`  ${formatFlag(f)}`);
    }
    console.log(
      `\n${results.length} doc(s) checked, ${criticalCount} critical flag(s).` +
        (criticalCount ? " Critical flags block status: complete." : ""),
    );
  }
  if (criticalCount > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`evidence.js: ${e.message || e}`);
    process.exit(1);
  });
}
