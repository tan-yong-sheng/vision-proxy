// Corpus location + doc model: root discovery, scanning, frontmatter-derived
// accessors. Extracted from docs.js with zero behavior change.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AREAS, TERMINAL_STATUS } from "./constants.js";
import { parseYaml } from "./yaml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function findRepoRoot() {
  if (process.env.AGENTS_DOCS_ROOT) {
    // Test/override: point the corpus elsewhere but keep repo-relative link
    // resolution anchored at the real repo root (inferred from this script).
    return walkUpForAgents();
  }
  return walkUpForAgents();
}

export function walkUpForAgents() {
  let dir = __dirname;
  while (true) {
    const candidates = [path.join(dir, ".agents", "docs"), path.join(dir, "docs")];
    if (fs.existsSync(candidates[0])) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not locate repo root (.agents/docs)");
    dir = parent;
  }
}

export const REPO_ROOT = walkUpForAgents();
export const DOCS =
  process.env.AGENTS_DOCS_ROOT != null
    ? path.resolve(process.env.AGENTS_DOCS_ROOT)
    : path.join(REPO_ROOT, ".agents", "docs");

export function docRoot() {
  if (!fs.existsSync(DOCS)) {
    fs.mkdirSync(DOCS, { recursive: true });
  }
  return DOCS;
}

export function walk(dir, base, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, base, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (entry.name === "index.md" || entry.name === "log.md") continue;
      out.push({ rel: path.relative(base, abs), abs });
    }
  }
  return out;
}

export function readDoc(entry) {
  const text = fs.readFileSync(entry.abs, "utf8");
  let fm = {};
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      try {
        fm = parseYaml(text.slice(4, end));
      } catch (e) {
        fm = { __parse_error: String(e.message || e) };
      }
      body = text.slice(end + 5);
    }
  }
  return { ...entry, text, fm, body };
}

export function scanDocs() {
  return walk(docRoot(), docRoot()).map(readDoc);
}

export function areaOf(doc) {
  const fm = doc.fm || {};
  if (fm.area && AREAS.includes(fm.area)) return fm.area;
  const m = /^(frontend|backend|fullstack)-/.exec(path.basename(doc.rel));
  if (m) return m[1];
  return null;
}

export function statusOf(doc) {
  return doc.fm.status || "active";
}

export function isTerminalStatus(type, status) {
  return !!(TERMINAL_STATUS[type] && TERMINAL_STATUS[type].includes(status));
}

export function isArchiveAnomaly(d) {
  // An archived doc must never silently read as active. With a known type we can
  // judge against its terminal set; without one (historical), accept any word
  // that reads finished and flag everything else.
  if (!d.rel.startsWith("archive/")) return false;
  const s = statusOf(d);
  if (s === "deprecated") return false;
  if (d.fm.type && isTerminalStatus(d.fm.type, s)) return false;
  const TERMINISH = ["complete", "landed", "fixed", "dead-end", "dropped", "abandoned", "wontfix", "retired", "done"];
  return !TERMINISH.includes(s);
}

export function daysSince(updated) {
  const t = new Date(String(updated).replace(/[":]/g, "").slice(0, 10) + "T00:00:00Z").getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}
