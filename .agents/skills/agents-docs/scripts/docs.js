#!/usr/bin/env bun
// agents-docs - deterministic bookkeeping for .agents/docs as an OKF v0.2 corpus.
//
// Authoring (markdown + frontmatter) is the LLM's job. This script only does the
// deterministic mechanics: create-from-template, status/report/index generation,
// archive moves, prune proposals, link rewriting, and the 8->6 structure migration.
// It never guesses - if a decision is ambiguous it fails loudly and asks a human.
//
// Usage: bun docs.js <command> [args] [flags]
//   new <type> <title> [--area frontend|backend|fullstack]
//   lookup <artifact>
//   visual <doc> <artifact>
//   sync <artifact> [--message "what changed"]
//   status [--show-archive]
//   report [--html [--out <path>]] [--check] [--show-archive]
//   index
//   clean [--dry-run] [--force] [--ttl <days>]
//   prune [--dry-run|--apply] [--gc] [--ttl <days>] [--force]
//   archive <doc> [--status <terminal-status>]
//   ensure [--dry-run|--apply]
//
// AGENTS_DOCS_ROOT overrides the corpus location (used by tests).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The 6 canonical lifecycle folders. `ensure` converges the tree to exactly these.
const FOLDERS = ["research", "plans", "worktrees", "bugs", "qa", "archive"];

// Types map to a home folder for `new`.
const TYPE_FOLDER = {
  research: "research",
  plan: "plans",
  worktree: "worktrees",
  bug: "bugs",
  coverage: "qa",
};

// Terminal (finished) statuses per type - the only statuses that justify archive.
const TERMINAL_STATUS = {
  research: ["complete", "dead-end"],
  plan: ["complete", "dropped"],
  worktree: ["landed", "abandoned"],
  bug: ["fixed", "wontfix"],
  coverage: ["retired"],
};

const AREAS = ["frontend", "backend", "fullstack"];

// Default status applied when `new` creates a doc of a given type.
const DEFAULT_STATUS = {
  research: "active",
  plan: "active",
  worktree: "active",
  bug: "open",
  coverage: "active",
};

// Retention window for archive garbage collection (prune --gc). Days.
const DEFAULT_TTL_DAYS = 180;

// Freshness threshold for active docs - older than this surfaces as stale. Days.
const STALE_DAYS = 180;

// Type-specific stale thresholds. Shorter for ephemeral work; longer for evidence.
const STALE_DAYS_BY_TYPE = {
  worktree: 14,
  research: 30,
  bug: 30,
  plan: 60,
  coverage: 90,
};

// Default terminal status applied by the `abandon` command per type.
const ABANDON_STATUS = {
  research: "dead-end",
  plan: "dropped",
  worktree: "abandoned",
  bug: "wontfix",
  coverage: "retired",
};

// Docs with entry_point: true are intentionally top-level and do not flag as orphan.
function isEntryPoint(doc) {
  return doc.fm.entry_point === true;
}

// ---------------------------------------------------------------------------
// Root + corpus location
// ---------------------------------------------------------------------------

function findRepoRoot() {
  if (process.env.AGENTS_DOCS_ROOT) {
    // Test/override: point the corpus elsewhere but keep repo-relative link
    // resolution anchored at the real repo root (inferred from this script).
    return walkUpForAgents();
  }
  return walkUpForAgents();
}

function walkUpForAgents() {
  let dir = __dirname;
  while (true) {
    const candidates = [path.join(dir, ".agents", "docs"), path.join(dir, "docs")];
    if (fs.existsSync(candidates[0])) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not locate repo root (.agents/docs)");
    dir = parent;
  }
}

const REPO_ROOT = walkUpForAgents();
const DOCS =
  process.env.AGENTS_DOCS_ROOT != null
    ? path.resolve(process.env.AGENTS_DOCS_ROOT)
    : path.join(REPO_ROOT, ".agents", "docs");

function docRoot() {
  if (!fs.existsSync(DOCS)) {
    fs.mkdirSync(DOCS, { recursive: true });
  }
  return DOCS;
}

// ---------------------------------------------------------------------------
// YAML subset: parse + serialize (zero deps, deterministic)
// ---------------------------------------------------------------------------

function parseValue(text) {
  text = text.trim();
  if (text === "") return null;
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner, ",").map((s) => parseScalar(s.trim()));
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1).trim();
    const o = {};
    if (inner !== "") {
      for (const part of splitTopLevel(inner, ",")) {
        const idx = part.indexOf(":");
        if (idx === -1) throw new Error(`bad inline map entry: ${part}`);
        o[part.slice(0, idx).trim()] = parseScalar(part.slice(idx + 1).trim());
      }
    }
    return o;
  }
  return parseScalar(text);
}

function parseScalar(s) {
  s = s.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.length >= 2 && (s[0] === '"' && s.endsWith('"') || s[0] === "'" && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth++;
    if (ch === "]" || ch === "}" || ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

function parseYaml(src) {
  const lines = src.split("\n");
  let i = 0;
  const peek = () => lines[i];
  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === "") i++;
  };
  const indentOf = (line) => /^(\s*)/.exec(line)[1].length;

  function node(minIndent) {
    skipBlank();
    if (i >= lines.length) return null;
    const line = peek();
    const ind = indentOf(line);
    if (ind < minIndent) return null;
    const body = line.trim();
    if (body.startsWith("-")) return list(ind);
    if (/^[\w.-]+:/.test(body)) return map(ind);
    i++;
    return parseScalar(body);
  }

  function map(ind) {
    const o = {};
    while (true) {
      skipBlank();
      if (i >= lines.length) break;
      const line = peek();
      const ind2 = indentOf(line);
      if (ind2 < ind) break;
      if (ind2 > ind) throw new Error(`bad indent: ${line}`);
      const body = line.trim();
      const m = /^([\w.-]+):\s*(.*)$/.exec(body);
      if (!m) throw new Error(`expected key: value - ${line}`);
      const key = m[1];
      const rest = m[2].trim();
      i++;
      if (rest === "" || rest === "|" || rest === ">") {
        skipBlank();
        if (i < lines.length && indentOf(peek()) > ind && peek().trim().startsWith("-")) {
          o[key] = list(indentOf(peek()));
        } else if (i < lines.length && indentOf(peek()) > ind) {
          o[key] = map(indentOf(peek()));
        } else {
          o[key] = null;
        }
      } else {
        o[key] = parseValue(rest);
      }
    }
    return o;
  }

  function list(ind) {
    const arr = [];
    while (true) {
      skipBlank();
      if (i >= lines.length) break;
      const line = peek();
      const ind2 = indentOf(line);
      if (ind2 < ind) break;
      if (ind2 > ind) throw new Error(`bad indent in list: ${line}`);
      const body = line.trim();
      if (!body.startsWith("- ")) break;
      const itemRest = body.slice(2).trim();
      i++;
      if (itemRest === "") {
        skipBlank();
        if (i < lines.length && indentOf(peek()) > ind) {
          if (peek().trim().startsWith("-")) arr.push(list(indentOf(peek())));
          else arr.push(map(indentOf(peek())));
        } else {
          arr.push(null);
        }
        continue;
      }
      const m = /^([\w.-]+):\s*(.*)$/.exec(itemRest);
      if (m) {
        const o = { [m[1]]: parseValue(m[2]) };
        while (i < lines.length && indentOf(peek()) === ind + 2) {
          const cm = /^([\w.-]+):\s*(.*)$/.exec(peek().trim());
          if (!cm) break;
          o[cm[1]] = parseValue(cm[2]);
          i++;
        }
        arr.push(o);
      } else {
        arr.push(parseValue(itemRest));
      }
    }
    return arr;
  }

  const v = node(0);
  if (v === null) return {};
  return typeof v === "object" && !Array.isArray(v) ? v : {};
}

function scalarStr(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (/[:#\[\]{},&*!|>'"%@`]|^\s|^[-?]|^\d/.test(s)) return JSON.stringify(s);
  return s;
}

function valueStr(v) {
  if (Array.isArray(v)) return `[${v.map((x) => scalarStr(x)).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${k}: ${scalarStr(x)}`).join(", ")}}`;
  }
  return scalarStr(v);
}

function emit(lines, key, value, ind) {
  const pad = " ".repeat(ind);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${key}: []`);
      return;
    }
    const inlineable = value.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x));
    if (inlineable && JSON.stringify(value).length <= 70) {
      lines.push(`${pad}${key}: [${value.map((x) => scalarStr(x)).join(", ")}]`);
      return;
    }
    lines.push(`${pad}${key}:`);
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          lines.push(`${pad}  - {}`);
        } else {
          lines.push(`${pad}  - ${entries[0][0]}: ${valueStr(entries[0][1])}`);
          for (const [ek, ev] of entries.slice(1)) lines.push(`${pad}    ${ek}: ${valueStr(ev)}`);
        }
      } else {
        lines.push(`${pad}  - ${valueStr(item)}`);
      }
    }
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`${pad}${key}: {}`);
      return;
    }
    if (entries.length <= 4 && JSON.stringify(value).length <= 90) {
      lines.push(`${pad}${key}: {${entries.map(([k, v]) => `${k}: ${valueStr(v)}`).join(", ")}}`);
      return;
    }
    lines.push(`${pad}${key}:`);
    for (const [k, v] of entries) emit(lines, k, v, ind + 2);
  } else {
    lines.push(`${pad}${key}: ${valueStr(value)}`);
  }
}

function serializeYaml(o) {
  const lines = [];
  for (const [k, v] of Object.entries(o)) emit(lines, k, v, 0);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Doc model
// ---------------------------------------------------------------------------

function walk(dir, base, out = []) {
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

function readDoc(entry) {
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

function scanDocs() {
  return walk(docRoot(), docRoot()).map(readDoc);
}

function areaOf(doc) {
  const fm = doc.fm || {};
  if (fm.area && AREAS.includes(fm.area)) return fm.area;
  const m = /^(frontend|backend|fullstack)-/.exec(path.basename(doc.rel));
  if (m) return m[1];
  return null;
}

function statusOf(doc) {
  return doc.fm.status || "active";
}

function isTerminalStatus(type, status) {
  return !!(TERMINAL_STATUS[type] && TERMINAL_STATUS[type].includes(status));
}

function isArchiveAnomaly(d) {
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

function daysSince(updated) {
  const t = new Date(String(updated).replace(/[":]/g, "").slice(0, 10) + "T00:00:00Z").getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
const REPO_LINK_RE = /\.agents\/docs\/[\w./-]+\.md/g;

function extractOutbound(text) {
  const out = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) out.push(m[1]);
  REPO_LINK_RE.lastIndex = 0;
  while ((m = REPO_LINK_RE.exec(text))) out.push(m[0]);
  return out;
}

function resolveTarget(href, fromAbs) {
  let h = href.replace(/^<|>$/g, "").split("#")[0].split("?")[0];
  if (!h || /^[a-z]+:/i.test(h) || h.startsWith("//")) return null;
  if (h.startsWith(".agents/")) return path.resolve(REPO_ROOT, h);
  if (h.startsWith("/")) return path.resolve(REPO_ROOT, h.slice(1));
  return path.resolve(path.dirname(fromAbs), h);
}

function buildLinkGraph(docs) {
  const byAbs = new Map(docs.map((d) => [d.abs, d]));
  const inbound = new Map(docs.map((d) => [d.rel, new Set()]));
  const dangling = new Map();
  for (const d of docs) {
    for (const href of extractOutbound(d.text)) {
      const abs = resolveTarget(href, d.abs);
      if (!abs) continue;
      const target = byAbs.get(abs);
      if (target) {
        inbound.get(target.rel).add(d.rel);
      } else if (abs.endsWith(".md") && !fs.existsSync(abs)) {
        const arr = dangling.get(d.rel) || [];
        arr.push(href);
        dangling.set(d.rel, arr);
      }
    }
  }
  return { inbound, dangling };
}

// ---------------------------------------------------------------------------
// Frontmatter read/write
// ---------------------------------------------------------------------------

function stripFrontmatter(text) {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) return text.slice(end + 5);
  }
  return text;
}

function withFrontmatter(text, fm) {
  return `---\n${serializeYaml(fm)}\n---\n${stripFrontmatter(text).replace(/^\n+/, "\n")}`;
}

function writeDoc(doc, text) {
  fs.writeFileSync(doc.abs, text);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

function kebab(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function fmt(rel) {
  return path.relative(REPO_ROOT, rel) || ".";
}

function die(msg, code = 1) {
  console.error(`docs.js: ${msg}`);
  process.exit(code);
}

function fail(msg) {
  throw new Error(msg);
}

// Find a doc from a user-supplied reference: a docs-relative path, or a bare
// filename (with or without area prefix) resolved by substring within a folder.
function findDoc(docs, ref) {
  const r = ref.replace(/^\.\//, "");
  let hit = docs.find((d) => d.rel === r || d.rel.endsWith("/" + r));
  if (hit) return hit;
  const base = path.basename(r);
  const folder = path.dirname(r);
  const candidates = docs.filter(
    (d) =>
      d.rel === base ||
      (folder && d.rel.startsWith(folder + "/") && d.rel.endsWith("/" + base)),
  );
  if (candidates.length === 0) fail(`no doc matches "${ref}"`);
  if (candidates.length > 1) fail(`ambiguous doc ref "${ref}" -> ${candidates.map((c) => c.rel).join(", ")}`);
  return candidates[0];
}

function appendLog(line) {
  const logPath = path.join(docRoot(), "log.md");
  const header = "# agents-docs log\n\nAppend-only lifecycle journal; oldest at top, newest at bottom.\n\n";
  let text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : header;
  text = text.replace(/\n*$/, "") + "\n" + line + "\n";
  fs.writeFileSync(logPath, text);
}

function relativeFrom(originAbs, targetAbs) {
  let rel = path.relative(path.dirname(originAbs), targetAbs);
  if (process.platform === "win32") rel = rel.split("\\").join("/");
  return rel.startsWith(".") ? rel : "./" + rel;
}

function renderHref(newAbs, fromAbs, originalHref) {
  if (originalHref.startsWith(".agents/")) return fmt(newAbs);
  if (originalHref.startsWith("/")) return "/" + path.relative(REPO_ROOT, newAbs);
  return relativeFrom(fromAbs, newAbs);
}

// Rewrite all outbound links in `text` (authored at fromAbs) that point at a doc
// in `moves` (absOld -> absNew), preserving the referencing style.
function rewriteOutbound(text, fromAbs, moves) {
  let t = text;
  for (const [oldAbs, newAbs] of Object.entries(moves)) {
    for (const href of extractOutbound(t)) {
      if (resolveTarget(href, fromAbs) === oldAbs) {
        t = t.split(href).join(renderHref(newAbs, fromAbs, href));
      }
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// index.md + report generation
// ---------------------------------------------------------------------------

function docStatusGroup(doc) {
  const s = statusOf(doc);
  if (["deferred"].includes(s)) return "deferred";
  if (TERMINAL_STATUS[doc.fm.type] && TERMINAL_STATUS[doc.fm.type].includes(s)) return "terminal";
  if (s === "deprecated") return "terminal";
  return "active";
}

function regenIndex(docs) {
  const byFolder = new Map();
  for (const d of docs) {
    const folder = path.dirname(d.rel) === "." ? "." : d.rel.split("/")[0];
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(d);
  }
  const order = [...FOLDERS.filter((f) => byFolder.has(f)), ...[...byFolder.keys()].filter((f) => !FOLDERS.includes(f))];
  const lines = [];
  lines.push("---");
  lines.push('okf_version: "0.2"');
  lines.push("---");
  lines.push("");
  lines.push("# agents-docs index");
  lines.push("");
  lines.push("Generated by `docs.js index`. Grouped by folder x status. Do not edit by hand - rerun the command.");
  lines.push("");
  let total = 0;
  for (const folder of order) {
    const list = byFolder.get(folder);
    const groups = { active: [], deferred: [], terminal: [] };
    for (const d of list) {
      const g = docStatusGroup(d);
      (groups[g] || (groups[g] = [])).push(d);
    }
    const flat = [
      ...(groups.active || []).sort((a, b) => (b.fm.updated || "").localeCompare(a.fm.updated || "")),
      ...(groups.deferred || []),
      ...(groups.terminal || []),
    ];
    if (flat.length === 0) continue;
    total += flat.length;
    lines.push(`## ${folder}/ (${flat.length})`);
    lines.push("");
    for (const d of flat) {
      const title = d.fm.title || path.basename(d.rel, ".md");
      const desc = d.fm.description || "";
      const area = areaOf(d);
      const parts = [];
      if (area) parts.push(`area: ${area}`);
      if (statusOf(d) !== "active") parts.push(`status: ${statusOf(d)}`);
      lines.push(`- [${title}](${relativeFrom(path.join(docRoot(), "index.md"), d.abs)}) - ${desc}${parts.length ? ` _(${parts.join(", ")})_` : ""}`);
    }
    lines.push("");
  }
  lines.push(`> ${total} docs indexed.`);
  fs.writeFileSync(path.join(docRoot(), "index.md"), lines.join("\n") + "\n");
  console.log(`index.md: ${total} docs`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const TEMPLATES = {
  research: (t) => `# ${t}\n\n## Question\n\n## Findings\n\n## Open questions\n`,
  plan: (t) => `# ${t}\n\n## Goal capsule\n\n## Current state\n\n## Target state\n\n## Key technical decisions\n\n## Deliverables\n\n## Worktree Strategy\n\n## Risks\n`,
  worktree: (t) => `# ${t}\n\n## Objective\n\n## Scope\n\n## Verification\n\n## Status\n`,
  bug: (t) => `# ${t}\n\n## Repro\n\n## Root cause\n\n## Fix\n\n## Verification\n`,
  coverage: (t) => `# ${t}\n\n## Surface covered\n\n## Resolution intent\n\n## Matrix\n\n## Retirement criteria\n`,
};

function cmdNew(args) {
  if (args.length < 2) die("usage: new <type> <title> [--area frontend|backend|fullstack]");
  const type = args[0];
  let area = "fullstack";
  const rest = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--area" && args[i + 1]) {
      area = args[++i];
    } else if (a.startsWith("--area=")) {
      area = a.slice("--area=".length);
    } else {
      rest.push(a);
    }
  }
  const title = rest.join(" ");
  if (!TYPE_FOLDER[type]) die(`unknown type "${type}" (expected: ${Object.keys(TYPE_FOLDER).join(", ")})`);
  if (!AREAS.includes(area)) die(`bad area "${area}" (expected: ${AREAS.join(", ")})`);
  const folder = TYPE_FOLDER[type];
  const filename = `${area}-${kebab(title)}.md`;
  const rel = `${folder}/${filename}`;
  const abs = path.join(docRoot(), rel);
  if (fs.existsSync(abs)) fail(`target exists - ${rel}`);
  const fm = {
    type,
    title,
    description: `${title} - one-line summary.`,
    area,
    tags: [],
    status: DEFAULT_STATUS[type],
    created: today(),
    updated: today(),
  };
  if (type === "bug") fm.priority = "medium";
  const staleDays = STALE_DAYS_BY_TYPE[type];
  if (staleDays) {
    const deadline = new Date(Date.now() + staleDays * 24 * 3600 * 1000);
    fm.stale_after = deadline.toISOString().slice(0, 10);
  }
  fm.related = [];
  const text = withFrontmatter(TEMPLATES[type](title), fm);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  appendLog(`- ${today()}: new ${type} ${rel}`);
  console.log(`created ${rel}`);
  regenIndex(scanDocs());
  maybeSweep();
}

function cmdLookup(args) {
  if (args.length < 1) die("usage: lookup <artifact>");
  const want = path.basename(args[0]);
  const docs = scanDocs();
  const hits = docs.filter((d) => {
    const v = d.fm.visual;
    return v && (path.basename(String(v)) === want || String(v).includes(args[0]));
  });
  if (hits.length === 0) {
    console.log(`no doc maps to artifact "${args[0]}"`);
    return;
  }
  for (const d of hits) console.log(d.rel);
}

function cmdVisual(args) {
  if (args.length < 2) die("usage: visual <doc> <artifact>");
  const docs = scanDocs();
  const doc = findDoc(docs, args[0]);
  const artifact = args[1];
  if (!fs.existsSync(path.resolve(REPO_ROOT, artifact))) fail(`artifact not found: ${artifact}`);
  if (!artifact.startsWith(".lavish/")) console.warn(`warning: ${artifact} is not under .lavish/ - not commit-safe`);
  const fm = { ...doc.fm, visual: artifact };
  writeDoc(doc, withFrontmatter(doc.body, fm));
  console.log(`${doc.rel}: visual = ${artifact}`);
  maybeSweep();
}

function cmdSync(args) {
  if (args.length < 1) die("usage: sync <artifact> [--message <text>]");
  const docs = scanDocs();
  const want = path.basename(args[0]);
  const hits = docs.filter((d) => {
    const v = d.fm.visual;
    return v && (path.basename(String(v)) === want || String(v).includes(args[0]));
  });
  if (hits.length === 0) fail(`no doc maps to artifact "${args[0]}" - run visual <doc> <artifact> first`);
  const msgFlag = args.find((a) => a.startsWith("--message="));
  const message = msgFlag ? msgFlag.split("=")[1] : "synced from lavish feedback";
  for (const d of hits) {
    const fm = { ...d.fm, updated: today() };
    writeDoc(d, withFrontmatter(d.body, fm));
    appendLog(`- ${today()}: sync ${d.rel} from ${args[0]} (${message})`);
    console.log(`synced ${d.rel}`);
  }
  regenIndex(scanDocs());
  maybeSweep();
}

function cmdStatus(args) {
  const showArchive = args.includes("--show-archive");
  const showOrphan = args.includes("--show-orphan");
  const docs = scanDocs();
  const graph = buildLinkGraph(docs);
  const rows = [];
  const archiveRows = [];
  for (const d of docs) {
    const s = statusOf(d);
    const area = areaOf(d);
    const updated = d.fm.updated || "";
    const archive = d.rel.startsWith("archive/");
    const type = d.fm.type || "(missing type)";
    const stale =
      !archive &&
      ((d.fm.stale_after && today() >= String(d.fm.stale_after)) ||
        (s === "active" && updated && updated < staleThresholdForType(type) && !d.fm.stale_after));
    const orphan = !isEntryPoint(d) && (!graph.inbound.get(d.rel) || graph.inbound.get(d.rel).size === 0);
    const row = { rel: d.rel, type, area: area || "-", status: s, updated, stale, orphan, anomaly: isArchiveAnomaly(d) };
    if (archive) archiveRows.push(row);
    else rows.push(row);
  }
  rows.sort((a, b) => a.rel.localeCompare(b.rel));
  if (!showArchive && archiveRows.length) {
    const oldest = archiveRows.map((r) => r.updated).filter(Boolean).sort()[0] || "-";
    const anomalies = archiveRows.filter((r) => r.anomaly).length;
    console.log(`archive/: ${archiveRows.length} docs, oldest ${oldest}${anomalies ? `, ${anomalies} !not-terminal` : ""} (--show-archive to expand)`);
  }
  console.log("FILE\tTYPE\tAREA\tSTATUS\tUPDATED\tFLAGS");
  for (const r of rows) {
    const flags = [r.stale ? "stale" : "", showOrphan && r.orphan ? "orphan" : ""].filter(Boolean).join(",");
    console.log([r.rel, r.type, r.area, r.status, r.updated || "-", flags || "-"].join("\t"));
  }
  if (showArchive) {
    const sorted = [...archiveRows].sort((a, b) => a.rel.localeCompare(b.rel));
    if (sorted.length) console.log("archive/ (--show-archive)");
    for (const r of sorted) {
      const flags = [r.anomaly ? "!not-terminal" : ""].filter(Boolean).join(",");
      console.log([r.rel, r.type, r.area, r.status, r.updated || "-", flags || "-"].join("\t"));
    }
  }
  const issues = rows.filter((r) => r.stale || r.type === "(missing type)");
  const orphanCount = rows.filter((r) => r.orphan).length;
  const anomalies = archiveRows.filter((r) => r.anomaly).length;
  if (issues.length || orphanCount || anomalies) {
    const parts = [];
    if (issues.length) parts.push(`${issues.length} doc(s) need attention (stale / missing type)`);
    if (orphanCount) parts.push(`${orphanCount} orphan doc(s)${showOrphan ? "" : " (run with --show-orphan to flag)"}`);
    if (anomalies) parts.push(`${anomalies} archived doc(s) read as non-terminal`);
    console.log(`\n${parts.join("; ")}.`);
  }
}

function staleThresholdForType(type) {
  const days = STALE_DAYS_BY_TYPE[type] || STALE_DAYS;
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function isUnhealthy(d, graph) {
  // archive/ docs never gate on stale/dangling - they are historical. The only
  // archive health signal is the anomaly flag (read as non-terminal), computed
  // separately so it can be surfaced without failing the gate.
  if (d.rel.startsWith("archive/")) return null;
  if (!d.fm.type) return "nonconformant";
  const s = statusOf(d);
  if (d.fm.stale_after && today() >= String(d.fm.stale_after)) return "stale";
  if (s === "active" && d.fm.updated && d.fm.updated < staleThresholdForType(d.fm.type)) return "stale";
  return null;
}

function buildReport({ showOrphan = false } = {}) {
  const docs = scanDocs();
  const graph = buildLinkGraph(docs);
  const rows = docs.map((d) => {
    const archive = d.rel.startsWith("archive/");
    const anomaly = isArchiveAnomaly(d);
    const reason = archive ? null : isUnhealthy(d, graph);
    const orphan = !isEntryPoint(d) && (!graph.inbound.get(d.rel) || graph.inbound.get(d.rel).size === 0);
    const dangling = archive ? [] : graph.dangling.get(d.rel) || [];
    const inbound = graph.inbound.get(d.rel) ? graph.inbound.get(d.rel).size : 0;
    return {
      rel: d.rel,
      archive,
      anomaly,
      type: d.fm.type || "(missing)",
      area: areaOf(d) || "-",
      status: statusOf(d),
      priority: d.fm.priority || "-",
      updated: d.fm.updated || "-",
      staleAfter: d.fm.stale_after || null,
      inbound,
      orphan,
      dangling,
      // orphan is advisory (top-level entry docs are legitimately unreferenced);
      // stale / dangling / nonconformant are the gate failures. Archive docs never
      // gate - an anomaly (reading non-terminal) surfaces but does not fail --check.
      fatal: !archive && (!!reason || dangling.length > 0),
      health: archive
        ? anomaly
          ? "not-terminal"
          : "ok"
        : reason || (dangling.length ? "dangling" : showOrphan && orphan ? "orphan" : "ok"),
    };
  });
  rows.sort((a, b) => (b.updated === "-" ? "" : b.updated).localeCompare(a.updated === "-" ? "" : a.updated));
  return { rows, docs, graph };
}

function cmdReport(args) {
  const showOrphan = args.includes("--show-orphan");
  const { rows } = buildReport({ showOrphan });
  const html = args.includes("--html");
  const showArchive = args.includes("--show-archive");
  const archiveRows = rows.filter((r) => r.archive);
  let view = rows.filter((r) => !r.archive);
  let archiveNote = null;
  if (!showArchive && archiveRows.length) {
    const oldest = archiveRows.map((r) => (r.updated === "-" ? "" : r.updated)).filter(Boolean).sort()[0] || "-";
    const anomalies = archiveRows.filter((r) => r.anomaly).length;
    archiveNote = { count: archiveRows.length, oldest, anomalies };
  } else if (showArchive) {
    view = rows; // live + archive, with `archive/` and anomaly columns
  }
  if (html) {
    const outFlag = args.find((a) => a.startsWith("--out="));
    const outAbs = outFlag ? path.resolve(REPO_ROOT, outFlag.split("=")[1]) : path.join(REPO_ROOT, ".lavish", "docs-report.html");
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, renderReportHtml(view, archiveNote));
    console.log(`report written to ${fmt(outAbs)}`);
  }
  const table = ["FILE\tTYPE\tAREA\tSTATUS\tPRIORITY\tUPDATED\tINBOUND\tHEALTH"];
  for (const r of view) {
    table.push([r.rel, r.type, r.area, r.status, r.priority, r.updated, r.inbound, r.archive ? `archive ${r.health}` : r.health].join("\t"));
  }
  if (archiveNote) table.push(`archive/: ${archiveNote.count} docs, oldest ${archiveNote.oldest}${archiveNote.anomalies ? `, ${archiveNote.anomalies} !not-terminal` : ""} (--show-archive to expand)`);
  console.log(table.join("\n"));
  if (args.includes("--check")) {
    const bad = view.filter((r) => r.fatal);
    if (bad.length) {
      console.error(`\n${bad.length} doc(s) unhealthy:`);
      for (const r of bad) console.error(`  ${r.rel} - ${r.health}`);
      process.exit(1);
    }
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderReportHtml(rows, archiveNote) {
  const healthClass = { ok: "ok", stale: "warn", orphan: "warn", dangling: "warn", nonconformant: "err", "not-terminal": "err" };
  const counts = { total: rows.length, ok: 0, stale: 0, orphan: 0, dangling: 0, nonconformant: 0, "not-terminal": 0 };
  for (const r of rows) counts[r.health] = (counts[r.health] || 0) + 1;
  const badges = ["ok", "stale", "orphan", "dangling", "nonconformant", "not-terminal"]
    .filter((k) => counts[k] > 0)
    .map((k) => `<span class="chip ${healthClass[k]}">${k}: ${counts[k]}</span>`)
    .join("");
  const archNote = archiveNote
    ? `<p class="arch-note">archive/: ${archiveNote.count} docs, oldest ${esc(archiveNote.oldest)}${archiveNote.anomalies ? `, ${archiveNote.anomalies} !not-terminal` : ""} (run report --show-archive to expand)</p>`
    : "";
  const body = rows
    .map(
      (r) =>
        `<tr><td class="f">${esc(r.rel)}</td><td>${esc(r.type)}</td><td>${esc(r.area)}</td><td>${esc(r.status)}</td><td>${esc(r.priority)}</td><td data-sort="${esc(r.updated)}">${esc(r.updated)}</td><td>${r.inbound}</td><td><span class="chip ${healthClass[r.health]}">${esc(r.health)}</span>${r.dangling.length ? `<span class="dang">dangling: ${esc(r.dangling.join(", "))}</span>` : ""}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agents-docs status report</title>
<style>
  :root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  body{max-width:1100px;margin:2rem auto;padding:0 1rem}
  h1{font-size:1.2rem}
  .chips{margin:1rem 0;display:flex;gap:.5rem;flex-wrap:wrap}
  .chip{font-size:.72rem;padding:.15rem .5rem;border-radius:999px;border:1px solid}
  .chip.ok{border-color:var(--ok,#2e7d32);color:var(--ok,#2e7d32)}
  .chip.warn{border-color:var(--warn,#b26a00);color:var(--warn,#b26a00)}
  .chip.err{border-color:var(--err,#b71c1c);color:var(--err,#b71c1c)}
  .arch-note{margin:1rem 0;font-size:.8rem;opacity:.8}
  .dang{display:block;font-size:.68rem;opacity:.7;margin-top:.2rem;max-width:340px;overflow-wrap:anywhere}
  table{border-collapse:collapse;width:100%;font-size:.8rem}
  th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #3332;white-space:nowrap}
  th{cursor:pointer;user-select:none}
  td.f{white-space:normal;min-width:220px;overflow-wrap:anywhere}
  th:hover{text-decoration:underline}
  .foot{margin-top:1rem;font-size:.7rem;opacity:.6}
</style></head>
<body>
<h1>agents-docs status report</h1>
${archNote}
<div class="chips">${badges}</div>
<table id="t"><thead><tr><th data-k="rel">file</th><th data-k="type">type</th><th data-k="area">area</th><th data-k="status">status</th><th data-k="priority">priority</th><th data-k="updated">updated</th><th data-k="inbound">inbound</th><th data-k="health">health</th></tr></thead><tbody>${body}</tbody></table>
<p class="foot">Generated by docs.js report --html. Derived from frontmatter + link graph; open any time, no server needed.</p>
<script>
const tb=document.querySelector('tbody');
document.querySelectorAll('th').forEach(th=>th.onclick=()=>{
  const k=th.dataset.k;
  const rows=[...tb.rows].sort((a,b)=>{
    const av=a.cells[th.cellIndex].dataset.sort??a.cells[th.cellIndex].textContent;
    const bv=b.cells[th.cellIndex].dataset.sort??b.cells[th.cellIndex].textContent;
    return String(av).localeCompare(String(bv),undefined,{numeric:true});
  });
  rows.forEach(r=>tb.appendChild(r));
});
</script>
</body></html>`;
}

function cmdPrune(args) {
  const apply = args.includes("--apply");
  const gc = args.includes("--gc");
  const force = args.includes("--force");
  const ttlFlag = args.find((a) => a.startsWith("--ttl="));
  const ttlDays = ttlFlag ? Number(ttlFlag.split("=")[1]) : DEFAULT_TTL_DAYS;
  const cutoff = new Date(Date.now() - ttlDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const docs = scanDocs();
  const graph = buildLinkGraph(docs);
  const archiveDir = path.join(docRoot(), "archive");
  const archiveCandidates = [];
  const gcCandidates = [];

  for (const d of docs) {
    const folder = d.rel.split("/")[0];
    const type = d.fm.type;
    const s = statusOf(d);
    if (folder === "archive") {
      const superseded = s === "deprecated" || (d.fm.superseded_by && String(d.fm.superseded_by) !== "null");
      const old = d.fm.updated && d.fm.updated < cutoff;
      if (superseded && old) gcCandidates.push(d.rel);
      continue;
    }
    const terminal = TERMINAL_STATUS[type] && TERMINAL_STATUS[type].includes(s);
    const superseded = d.fm.superseded_by && String(d.fm.superseded_by) !== "null";
    if (terminal || superseded) archiveCandidates.push({ rel: d.rel, reason: terminal ? `status ${s}` : "superseded_by" });
  }

  // GC is gated on references: an archive doc still linked from a live doc is
  // evidence, not garbage. Refuse with the linker names; --force overrides.
  const gcRefused = (rel) => {
    const inbound = graph.inbound.get(rel);
    return inbound && inbound.size ? [...inbound] : null;
  };

  if (gcCandidates.length === 0 && archiveCandidates.length === 0) {
    console.log("nothing to prune");
    return;
  }

  console.log("archive candidates:");
  for (const c of archiveCandidates) console.log(`  ${c.rel} (${c.reason})`);
  if (gc) {
    console.log("archive GC candidates (superseded + older than TTL):");
    for (const c of gcCandidates) {
      const refs = gcRefused(c);
      if (refs && !force) console.log(`  gc-refused ${c} (still referenced by ${refs.join(", ")}) - pass --force to override`);
      else console.log(`  ${c}`);
    }
  } else {
    console.log(`(run with --gc to include archive garbage collection, default TTL ${ttlDays}d)`);
  }

  if (!apply) {
    console.log("\ndry-run: re-run with --apply to archive");
    return;
  }
  for (const c of archiveCandidates) {
    const d = findDoc(docs, c.rel);
    performArchive(d, docs, { reason: c.reason });
  }
  if (gc) {
    for (const c of gcCandidates) {
      const refs = gcRefused(c);
      if (refs && !force) continue;
      const abs = path.join(docRoot(), c);
      fs.unlinkSync(abs);
      appendLog(`- ${today()}: prune gc ${c}`);
      console.log(`deleted ${c}`);
    }
  }
  regenIndex(scanDocs());
}

function archiveBasename(type, rel) {
  const base = path.basename(rel);
  const prefix = type ? `${type}-` : "";
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}

function performArchive(doc, docs, opts) {
  const type = doc.fm.type;
  const defaults = TERMINAL_STATUS[type] ? TERMINAL_STATUS[type][0] : null;
  let status = opts.status;
  if (!status) status = opts.reason === "superseded_by" ? "complete" : defaults || "complete";
  const newRel = `archive/${archiveBasename(type, doc.rel)}`;
  const newAbs = path.join(docRoot(), newRel);
  if (fs.existsSync(newAbs)) fail(`target exists - ${newRel}`);
  fs.mkdirSync(path.join(docRoot(), "archive"), { recursive: true });
  // 1. move the file
  fs.renameSync(doc.abs, newAbs);
  // 2. fix the moved doc's own outbound links (relative to new location)
  const moves = { [doc.abs]: newAbs };
  let text = doc.text;
  text = rewriteOutbound(text, doc.abs, moves);
  // 3. rewrite inbound links in every other doc
  for (const other of docs) {
    if (other.rel === doc.rel) continue;
    const outboundHrefs = new Set(extractOutbound(other.text).filter((h) => resolveTarget(h, other.abs) === doc.abs));
    if (outboundHrefs.size === 0) continue;
    let t = other.text;
    for (const href of outboundHrefs) t = t.split(href).join(renderHref(newAbs, other.abs, href));
    writeDoc(other, t);
  }
  // 4. set terminal status in frontmatter
  const fm = { ...doc.fm, status };
  fs.writeFileSync(newAbs, withFrontmatter(text, fm));
  appendLog(`- ${today()}: archive ${doc.rel} -> ${newRel} (${status})`);
  console.log(`archived ${doc.rel} -> ${newRel} (status: ${status})`);
}

function cmdArchive(args) {
  if (args.length < 1) die("usage: archive <doc> [--status <terminal-status>]");
  const docs = scanDocs();
  const doc = findDoc(docs, args[0]);
  const statusFlag = args.find((a) => a.startsWith("--status="));
  const status = statusFlag ? statusFlag.split("=")[1] : null;
  performArchive(doc, docs, { status });
  regenIndex(scanDocs());
  maybeSweep();
}

function cmdAbandon(args) {
  if (args.length < 1) die("usage: abandon <doc> [--status=<terminal-status>] [--dry-run]");
  const dryRun = args.includes("--dry-run");
  const docs = scanDocs();
  const doc = findDoc(docs, args[0]);
  const type = doc.fm.type;
  const statusFlag = args.find((a) => a.startsWith("--status="));
  const status = statusFlag ? statusFlag.split("=")[1] : ABANDON_STATUS[type];
  if (!status) fail(`cannot abandon doc of type "${type || "(missing)"}" - set --status explicitly`);
  const terminal = TERMINAL_STATUS[type] || [];
  if (!terminal.includes(status)) fail(`status "${status}" is not terminal for type "${type}"`);
  const archiveName = archiveBasename(type, doc.rel);
  if (dryRun) {
    console.log(`would abandon ${doc.rel} -> archive/${archiveName} (status: ${status})`);
    return;
  }
  performArchive(doc, docs, { status });
  regenIndex(scanDocs());
  maybeSweep();
}

function cmdRevive(args) {
  if (args.length < 1) die("usage: revive <archive-doc>");
  const docs = scanDocs();
  let ref = args[0];
  if (!ref.startsWith("archive/")) {
    const candidate = docs.find((d) => d.rel === `archive/${ref}` || d.rel.endsWith(`/archive/${ref}`));
    if (candidate) ref = candidate.rel;
    else ref = `archive/${ref}`;
  }
  const doc = findDoc(docs, ref);
  if (!doc.rel.startsWith("archive/")) {
    fail(`"${doc.rel}" is not an archived doc (only archive/ docs can be revived)`);
  }

  // Infer type: from frontmatter, or from filename prefix (research-, plan-, worktree-, bug-, coverage-, dossier-)
  let type = doc.fm.type;
  const baseName = path.basename(doc.rel);
  if (!type || !TYPE_FOLDER[type]) {
    for (const t of Object.keys(TYPE_FOLDER)) {
      if (baseName.startsWith(`${t}-`)) {
        type = t;
        break;
      }
    }
  }
  if (!type || !TYPE_FOLDER[type]) {
    fail(`cannot infer active folder for "${doc.rel}" - type is missing or unknown`);
  }

  const folder = TYPE_FOLDER[type];
  // Strip <type>- prefix from filename if present
  let activeFilename = baseName;
  if (activeFilename.startsWith(`${type}-`)) {
    activeFilename = activeFilename.slice(type.length + 1);
  }

  const targetRel = `${folder}/${activeFilename}`;
  const targetAbs = path.join(docRoot(), targetRel);
  if (fs.existsSync(targetAbs)) {
    fail(`target exists - ${targetRel}`);
  }

  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.renameSync(doc.abs, targetAbs);

  // 1. Rewrite outbound links relative to new location
  const moves = { [doc.abs]: targetAbs };
  let text = rewriteOutbound(doc.text, doc.abs, moves);

  // 2. Rewrite inbound links in other docs
  for (const other of docs) {
    if (other.rel === doc.rel) continue;
    const outboundHrefs = new Set(extractOutbound(other.text).filter((h) => resolveTarget(h, other.abs) === doc.abs));
    if (outboundHrefs.size === 0) continue;
    let t = other.text;
    for (const href of outboundHrefs) t = t.split(href).join(renderHref(targetAbs, other.abs, href));
    writeDoc(other, t);
  }

  // 3. Reset frontmatter
  const status = DEFAULT_STATUS[type] || "active";
  const fm = { ...doc.fm, type, status, updated: today() };
  if (fm.superseded_by) delete fm.superseded_by;
  const staleDays = STALE_DAYS_BY_TYPE[type];
  if (staleDays) {
    const deadline = new Date(Date.now() + staleDays * 24 * 3600 * 1000);
    fm.stale_after = deadline.toISOString().slice(0, 10);
  }

  fs.writeFileSync(targetAbs, withFrontmatter(text, fm));
  appendLog(`- ${today()}: revive ${doc.rel} -> ${targetRel}`);
  console.log(`revived ${doc.rel} -> ${targetRel} (status: ${status})`);
  regenIndex(scanDocs());
  maybeSweep();
}

function parseWorktreeTracks(planDoc) {
  const text = planDoc.text;
  const tracks = [];
  const lines = text.split("\n");
  let inTrackSection = false;
  let currentTrack = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s+(Worktree Strategy|Worktree Tracks|Worktrees)/i.test(line)) {
      inTrackSection = true;
      continue;
    }
    if (inTrackSection && /^##\s+/.test(line)) {
      if (currentTrack) tracks.push(currentTrack);
      currentTrack = null;
      inTrackSection = false;
      continue;
    }

    if (inTrackSection) {
      const trackHeader = /^###\s+(.*)/.exec(line);
      if (trackHeader) {
        if (currentTrack) tracks.push(currentTrack);
        const headerContent = trackHeader[1].trim();
        let branch = "";
        let title = "";
        const branchMatch = /`([^`]+)`/.exec(headerContent);
        if (branchMatch) {
          branch = branchMatch[1];
          title = headerContent.replace(/`[^`]+`/, "").replace(/^Track\s*\d+[:\-]?\s*/i, "").replace(/^[:\-]\s*/, "").trim();
        } else {
          title = headerContent.replace(/^Track\s*\d+[:\-]?\s*/i, "").trim();
        }
        if (!title && branch) title = branch.split("/").pop().replace(/^[a-z]+-/, "");
        if (!title) title = "Worktree Track";
        if (!branch) branch = `feat/${kebab(title)}`;

        currentTrack = {
          branch,
          title,
          area: planDoc.fm.area || "fullstack",
          objective: "",
          scope: "",
          tasks: [],
          verification: "npm test",
          dependsOn: []
        };
        continue;
      }

      if (currentTrack) {
        if (/^-\s+\*\*Area\*\*:\s*(.*)/i.test(line)) {
          const a = line.replace(/^-\s+\*\*Area\*\*:\s*/i, "").trim().toLowerCase();
          if (AREAS.includes(a)) currentTrack.area = a;
        } else if (/^-\s+\*\*Branch\*\*:\s*`?([a-zA-Z0-9_\-\/]+)`?/i.test(line)) {
          const b = line.replace(/^-\s+\*\*Branch\*\*:\s*/i, "").replace(/[`*]/g, "").trim();
          if (b) currentTrack.branch = b;
        } else if (/^-\s+\*\*Objective\*\*:\s*(.*)/i.test(line)) {
          currentTrack.objective = line.replace(/^-\s+\*\*Objective\*\*:\s*/i, "").trim();
        } else if (/^-\s+\*\*Scope(?:\s*&\s*Files)?\*\*:\s*(.*)/i.test(line)) {
          currentTrack.scope = line.replace(/^-\s+\*\*Scope(?:\s*&\s*Files)?\*\*:\s*/i, "").trim();
        } else if (/^-\s+\*\*Verification(?:\s*Criteria)?\*\*:\s*(.*)/i.test(line)) {
          currentTrack.verification = line.replace(/^-\s+\*\*Verification(?:\s*Criteria)?\*\*:\s*/i, "").trim();
        } else if (/^-\s+\*\*Depends\s*On\*\*:\s*(.*)/i.test(line)) {
          const d = line.replace(/^-\s+\*\*Depends\s*On\*\*:\s*/i, "").trim();
          if (d && !/none/i.test(d)) currentTrack.dependsOn.push(d);
        } else if (/^-\s+\[\s*\]\s+(.*)/.test(line)) {
          currentTrack.tasks.push(line.replace(/^-\s+\[\s*\]\s+/, "").trim());
        }
      }
    }
  }
  if (currentTrack) tracks.push(currentTrack);

  // Strategy 2: If no tracks from ## Worktree Strategy, check Deliverables table
  if (tracks.length === 0) {
    let inDeliverables = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^##\s+Deliverables/i.test(line)) {
        inDeliverables = true;
        continue;
      }
      if (inDeliverables && /^##\s+/.test(line)) {
        inDeliverables = false;
        break;
      }
      if (inDeliverables && line.startsWith("|") && !line.includes("---")) {
        const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
        if (cols.length >= 2 && !/^(#|Deliverable|Track)/i.test(cols[0]) && !/^(Deliverable|Name)/i.test(cols[1])) {
          const delivTitle = cols.length >= 3 && /^\d+$/.test(cols[0]) ? cols[1] : cols[0];
          const delivFiles = cols.length >= 3 ? cols[2] : cols[1];
          if (delivTitle) {
            tracks.push({
              branch: `feat/${kebab(delivTitle)}`,
              title: delivTitle,
              area: planDoc.fm.area || "fullstack",
              objective: `Implement ${delivTitle}`,
              scope: delivFiles || "See plan deliverables.",
              tasks: [`Implement ${delivTitle}`, `Add unit tests for ${delivTitle}`],
              verification: "npm test",
              dependsOn: []
            });
          }
        }
      }
    }
  }

  // Strategy 3: Fallback to 1 track matching the plan itself
  if (tracks.length === 0) {
    tracks.push({
      branch: `feat/${kebab(planDoc.fm.title || path.basename(planDoc.rel, ".md"))}`,
      title: planDoc.fm.title || "Implementation",
      area: planDoc.fm.area || "fullstack",
      objective: planDoc.fm.description || `Implement ${planDoc.fm.title}`,
      scope: "See plan deliverables.",
      tasks: [`Implement ${planDoc.fm.title} per plan`],
      verification: "npm test",
      dependsOn: []
    });
  }

  return tracks;
}

function cmdScaffoldWorktrees(args) {
  if (args.length < 1) die("usage: scaffold-worktrees <plan-doc>");
  const docs = scanDocs();
  const planDoc = findDoc(docs, args[0]);
  if (planDoc.fm.type !== "plan") {
    fail(`"${planDoc.rel}" is not a plan (type is "${planDoc.fm.type}")`);
  }

  const tracks = parseWorktreeTracks(planDoc);
  const created = [];
  const skipped = [];

  for (const track of tracks) {
    const rawSlug = track.branch.includes("/") ? track.branch.split("/").pop() : kebab(track.title);
    const slug = kebab(rawSlug.replace(/^(frontend|backend|fullstack)-/, ""));
    const filename = `${track.area}-${slug}.md`;
    const rel = `worktrees/${filename}`;
    const abs = path.join(docRoot(), rel);

    if (fs.existsSync(abs)) {
      skipped.push(rel);
      continue;
    }

    const fm = {
      type: "worktree",
      title: track.title,
      description: track.objective || `${track.title} - implementation track for ${planDoc.fm.title}.`,
      area: track.area,
      tags: planDoc.fm.tags || [],
      status: "active",
      created: today(),
      updated: today(),
      stale_after: new Date(Date.now() + (STALE_DAYS_BY_TYPE.worktree || 14) * 24 * 3600 * 1000).toISOString().slice(0, 10),
      related: [`../plans/${path.basename(planDoc.rel)}`],
    };
    if (track.dependsOn && track.dependsOn.length) {
      fm.depends_on = track.dependsOn;
    }

    const taskList = track.tasks.length
      ? track.tasks.map((t) => `- [ ] ${t}`).join("\n")
      : "- [ ] Implementation complete";

    const body = `# ${track.title}

## Objective

${track.objective || track.title}

## Scope

${track.scope || "See plan deliverables."}

## Tasks

${taskList}

## Verification

${track.verification || "npm test"}

## Status

- [ ] Worktree created
- [ ] Implementation complete
- [ ] Tests pass
- [ ] Landed on feature branch (ready for PR/merge)
`;

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, withFrontmatter(body, fm));
    appendLog(`- ${today()}: scaffold-worktrees ${planDoc.rel} -> ${rel}`);
    created.push(rel);
  }

  for (const c of created) console.log(`created ${c}`);
  for (const s of skipped) console.log(`skipped ${s} (target exists)`);
  if (created.length === 0 && skipped.length === 0) console.log("no worktrees to scaffold");
  if (created.length) regenIndex(scanDocs());
  maybeSweep();
}

// ---------------------------------------------------------------------------
// clean - auto-archive / auto-prune sweep
// ---------------------------------------------------------------------------

// The auto model: "is done?" is semantic (declared in conversation or in the
// doc's frontmatter) - the sweep never guesses. "move the done doc" is
// mechanical and fully automatic. Four automatic rules + one advisory:
//
//   auto-archive       - an active doc whose status is terminal, or that carries a
//                        superseded_by, moves to archive/ on the next sweep.
//   auto-prune         - an archive doc that is superseded AND past the TTL (default
//                        180d) AND unreferenced may be GC'd. If still referenced it is
//                        refused with linker names; --force overrides the guard.
//   auto-cadence       - the sweep runs at the end of every lifecycle command and
//                        before review gates (Decision B: every checkpoint).
//   stale-orphan sweep - optional --stale-orphan archives active docs that are both
//                        stale (per type-specific thresholds) AND unreferenced.
//                        Dry-run by default; requires --apply to move files.
//   (advisory)         - active docs older than their type's stale threshold with no
//                        stale_after and no terminal status are surfaced as
//                        "declare live or dead". Never auto-archived; standing evidence
//                        is a legitimate stable state.
//
// runSweep is deterministic and pure about decisions: apply=false only proposes,
// apply=true performs. quiet suppresses the empty filler but never the alerts
// (stale, anomaly, gc-refused), so the auto cadence surfaces what needs a human.
function isStaleOrphan(d, graph) {
  if (d.rel.startsWith("archive/")) return false;
  if (isEntryPoint(d)) return false;
  const s = statusOf(d);
  if (s !== "active" && s !== "open") return false;
  const inbound = graph.inbound.get(d.rel);
  if (inbound && inbound.size) return false;
  if (d.fm.stale_after && today() >= String(d.fm.stale_after)) return true;
  if (!d.fm.updated) return false;
  const age = daysSince(d.fm.updated);
  return age != null && age > (STALE_DAYS_BY_TYPE[d.fm.type] || STALE_DAYS);
}

function runSweep({ apply = false, force = false, ttlDays = DEFAULT_TTL_DAYS, quiet = false, staleOrphan = false } = {}) {
  const docs = scanDocs();
  const graph = buildLinkGraph(docs);
  const out = {
    archiveCandidates: [],
    gcCandidates: [],
    gcRefused: [],
    stale: [],
    anomalies: [],
    archived: [],
    gcDeleted: [],
    skipped: [],
  };
  for (const d of docs) {
    const rel = d.rel;
    if (rel.startsWith("archive/")) {
      const s = statusOf(d);
      if (isArchiveAnomaly(d)) out.anomalies.push({ rel, status: s });
      const superseded = s === "deprecated" || (d.fm.superseded_by && String(d.fm.superseded_by) !== "null");
      const age = daysSince(d.fm.updated);
      if (!(superseded && age != null && age > ttlDays)) continue;
      const inbound = graph.inbound.get(rel);
      const refs = inbound && inbound.size ? [...inbound] : null;
      if (refs && !force) out.gcRefused.push({ rel, refs });
      else out.gcCandidates.push(rel);
      continue;
    }
    const s = statusOf(d);
    const terminal = isTerminalStatus(d.fm.type, s);
    const superseded = d.fm.superseded_by && String(d.fm.superseded_by) !== "null";
    if (terminal || superseded) {
      out.archiveCandidates.push({ rel, reason: terminal ? `status ${s}` : "superseded_by" });
    } else if (staleOrphan && isStaleOrphan(d, graph)) {
      out.archiveCandidates.push({ rel, reason: "stale + orphan" });
    } else if (s === "active" && !d.fm.stale_after && d.fm.updated) {
      const age = daysSince(d.fm.updated);
      if (age != null && age > (STALE_DAYS_BY_TYPE[d.fm.type] || STALE_DAYS)) out.stale.push({ rel, age });
    }
  }

  const alertLines = [
    ...out.stale.map((st) => `stale: ${st.rel} (updated ${st.age}d ago) - declare live (stale_after or update) or dead (terminal status); clean archives it`),
    ...out.anomalies.map((a) => `!not-terminal ${a.rel} (status: ${a.status}) - set a terminal status`),
    ...out.gcRefused.map((r) => `gc-refused ${r.rel} (still referenced by ${r.refs.join(", ")}) - pass --force to override`),
  ];

  if (!apply && !quiet) {
    for (const c of out.archiveCandidates) console.log(`  would auto-archive ${c.rel} (${c.reason})`);
    for (const c of out.gcCandidates) console.log(`  would gc ${c.rel} (superseded + past ${ttlDays}d TTL)`);
    for (const l of alertLines) console.log(l);
    if (out.archiveCandidates.length + out.gcCandidates.length === 0) console.log("nothing to clean");
    if (staleOrphan) console.log("\n(stale-orphan mode: re-run with --apply to archive these docs)");
  }

  if (!apply) return out;

  for (const c of out.archiveCandidates) {
    const d = findDoc(docs, c.rel);
    try {
      performArchive(d, docs, { reason: c.reason });
      out.archived.push(c.rel);
    } catch (e) {
      out.skipped.push({ rel: c.rel, message: e.message });
      console.log(`auto-archive-skip ${c.rel}: ${e.message}`);
    }
  }
  for (const rel of out.gcCandidates) {
    fs.unlinkSync(path.join(docRoot(), rel));
    appendLog(`- ${today()}: prune gc ${rel}`);
    out.gcDeleted.push(rel);
    console.log(`gc: deleted ${rel}`);
  }
  if (out.archived.length || out.gcDeleted.length) regenIndex(scanDocs());
  for (const l of alertLines) console.log(l);
  return out;
}

function cmdClean(args) {
  const staleOrphan = args.includes("--stale-orphan");
  const applyFlag = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const ttlFlag = args.find((a) => a.startsWith("--ttl="));
  const ttlDays = ttlFlag ? Number(ttlFlag.split("=")[1]) : DEFAULT_TTL_DAYS;
  // stale-orphan archives docs that are not explicitly terminal; require --apply to actually move them.
  const apply = staleOrphan ? applyFlag : !dryRun;
  const out = runSweep({ apply, force, ttlDays, staleOrphan });
  if (apply && out.archived.length + out.gcDeleted.length === 0) {
    console.log("clean: nothing to auto-archive or gc");
  }
  if (staleOrphan && !apply) {
    console.log("\nrun with --apply to archive the stale-orphan docs above");
  }
}

// Decision B (every checkpoint): run the sweep silently at the end of lifecycle
// commands. Alerts (stale / anomaly / gc-refused) surface; the empty filler is
// suppressed. Never lets an auto-sweep kill the command that triggered it.
function maybeSweep() {
  try {
    runSweep({ apply: true, quiet: true });
  } catch (e) {
    console.error(`clean: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// ensure - converge the 8-folder corpus onto the 6-folder structure
// ---------------------------------------------------------------------------

// Explicit area mapping for the one-time migration (matches the reviewed target
// inventory). Dossiers keep numeric-sequence names; area lives in frontmatter.
const MIGRATION_AREA = {
  "research/flutter-to-react-native-migration.md": "frontend",
  "research/flutter-ui-regression-prevention.md": "frontend",
  "research/mastra-versions.md": "backend",
  "research/model-configuration-strategy.md": "backend",
  "research/server-driven-model-list.md": "backend",
  "research/worktrunk-agentic-coding.md": "fullstack",
  "research/worktrunk-orca-delegation-optimization.md": "fullstack",
  "worktrees/rn-parity-gaps-plan.md": "frontend",
  "worktrees/flutter-to-react-native-delegation.md": "frontend",
  "bugs/chat-hardcoded-api-url.md": "frontend",
  "bugs/chat-stale-google-model-id.md": "frontend",
  "bugs/static-server-model-registry.md": "backend",
};

// One-time folder renames (source folder -> target folder).
const FOLDER_MOVES = { archived: "archive", verification: "qa/verification" };

// One-time exact file renames/moves. The plan file drops its date prefix; the
// deferred doc moves to plans/ with a backend- prefix (the reviewed target
// inventory is authoritative, not the earlier fullstack- draft in the plan's
// migration table).
const MIGRATION_RENAME = {
  "plans/2026-08-08-001-refactor-flutter-to-react-native-plan.md":
    "plans/frontend-flutter-to-react-native-migration.md",
  "defer/mastra-serverless-native.md": "plans/backend-serverless-native.md",
};

function inferTypeForRel(effRel) {
  const seg = effRel.split("/")[0];
  if (seg === "research") return "research";
  if (seg === "plans") return "plan";
  if (seg === "worktrees") return "worktree";
  if (seg === "bugs") return "bug";
  if (seg === "qa") return effRel.includes("/") ? "dossier" : "coverage";
  return null;
}

function cmdEnsure(args) {
  const apply = args.includes("--apply");
  const actions = [];
  const notes = [];
  const docs = scanDocs();

  // ---- Phase 1: plan every change (nothing written) ----------------------
  // One truth: folderMoves (clean source folder -> target), renameMap (rel -> newRel).
  const folderMoves = {};
  for (const [fromFolder, toFolder] of Object.entries(FOLDER_MOVES)) {
    const fromAbs = path.join(docRoot(), fromFolder);
    if (!fs.existsSync(fromAbs)) continue;
    if (fs.existsSync(path.join(docRoot(), toFolder))) {
      notes.push(`${fromFolder}/ and ${toFolder}/ both exist - merge manually`);
      continue;
    }
    folderMoves[fromFolder] = toFolder;
  }
  const renameMap = new Map();
  for (const [fromRel, toRel] of Object.entries(MIGRATION_RENAME)) {
    if (!fs.existsSync(path.join(docRoot(), fromRel))) continue;
    if (fs.existsSync(path.join(docRoot(), toRel))) {
      notes.push(`${toRel} already exists - cannot move ${fromRel}`);
      continue;
    }
    renameMap.set(fromRel, toRel);
  }
  for (const d of docs) {
    const rel = d.rel;
    if (renameMap.has(rel)) continue;
    const folder = rel.split("/")[0];
    if (!FOLDERS.includes(folder) || folder === "qa" || folder === "archive") continue;
    if (/^(frontend|backend|fullstack)-/.test(path.basename(rel))) continue;
    const area = MIGRATION_AREA[rel];
    if (!area) continue; // no mapping is fine - leave as-is
    const newRel = `${folder}/${area}-${path.basename(rel)}`;
    if (newRel === rel) continue;
    if (fs.existsSync(path.join(docRoot(), newRel)) || new Set(renameMap.values()).has(newRel)) {
      notes.push(`${newRel} already exists - cannot rename ${rel} without a decision`);
      continue;
    }
    renameMap.set(rel, newRel);
  }

  // Post-move location of a doc: folder move first, then rename map lookup.
  const postRel = (rel) => {
    const seg = rel.split("/")[0];
    const moved = folderMoves[seg] ? folderMoves[seg] + rel.slice(seg.length) : rel;
    return renameMap.get(moved) || moved;
  };

  // ---- Phase 2: apply (or report) every planned change --------------------
  for (const [fromAbs, toFolder] of Object.entries(folderMoves)) {
    actions.push({ from: `${fromAbs}/`, to: `${toFolder}/`, note: "folder move" });
    if (apply) {
      fs.mkdirSync(path.dirname(path.join(docRoot(), toFolder)), { recursive: true });
      fs.renameSync(path.join(docRoot(), fromAbs), path.join(docRoot(), toFolder));
    }
  }
  for (const [fromRel, toRel] of renameMap) {
    actions.push({ from: fromRel, to: toRel });
    if (apply) {
      const fromAbs = path.join(docRoot(), fromRel);
      const toAbs = path.join(docRoot(), toRel);
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      fs.renameSync(fromAbs, toAbs);
      const moved = readDoc({ rel: toRel, abs: toAbs });
      const fm = { ...moved.fm };
      if (fromRel.startsWith("defer/")) fm.status = "deferred";
      const area = MIGRATION_AREA[fromRel];
      if (area) fm.area = area;
      fs.writeFileSync(toAbs, withFrontmatter(moved.body, fm));
    }
  }

  // Frontmatter conformance - reason on the POST-move location so dry-run and
  // apply agree. Adds missing type/area/created/updated; never overwrites an
  // existing field. archive/ docs get no guessed type (historical).
  for (const d of docs) {
    const effRel = postRel(d.rel);
    const fm = { ...d.fm };
    const added = [];
    if (!fm.type) {
      const inferred = inferTypeForRel(effRel);
      if (inferred) {
        fm.type = inferred;
        added.push("type");
      } else if (!effRel.startsWith("archive/")) {
        notes.push(`${effRel}: cannot infer type - manual`);
      }
    }
    if (!fm.area) {
      const area = areaOf({ rel: effRel }) || MIGRATION_AREA[d.rel] || null;
      if (area) {
        fm.area = area;
        added.push("area");
      } else if (!effRel.startsWith("archive/")) {
        fm.area = "fullstack";
        added.push("area");
      }
    }
    if (!fm.created || !fm.updated) {
      // Stat the post-move path in apply mode (rename just happened), else the
      // pre-move path in dry-run. rename preserves mtime, so both are identical.
      const statPath = fs.existsSync(path.join(docRoot(), effRel))
        ? path.join(docRoot(), effRel)
        : d.abs;
      const stat = fs.statSync(statPath).mtime.toISOString().slice(0, 10);
      if (!fm.created) {
        fm.created = stat;
        added.push("created");
      }
      if (!fm.updated) {
        fm.updated = stat;
        added.push("updated");
      }
    }
    if (added.length) {
      actions.push({ from: effRel, note: `adds ${added.join(", ")}` });
      if (apply) {
        const effAbs = path.join(docRoot(), effRel);
        fs.mkdirSync(path.dirname(effAbs), { recursive: true });
        fs.writeFileSync(effAbs, withFrontmatter(d.body, fm));
      }
    }
  }

  // Cross-link normalization: .agents/docs/<path> -> file-relative. Resolves
  // through the move map so links to moved docs are rewritten to new locations.
  if (apply) {
    const finalDocs = scanDocs();
    const finalByRel = new Map(finalDocs.map((d) => [postRel(d.rel), d]));
    for (const d of finalDocs) {
      let t = d.text;
      const hrefs = new Set(extractOutbound(t).filter((h) => h.startsWith(".agents/docs/")));
      for (const href of hrefs) {
        const abs = resolveTarget(href, d.abs);
        if (!abs) continue;
        const targetRel = path.relative(docRoot(), abs);
        const finalTarget = finalByRel.get(postRel(targetRel));
        if (!finalTarget) continue;
        const newHref = relativeFrom(d.abs, finalTarget.abs);
        if (newHref !== href) {
          t = t.split(href).join(newHref);
          actions.push({ from: d.rel, note: `link ${href} -> ${newHref}` });
        }
      }
      if (t !== d.text) writeDoc(d, t);
    }
  }

  // Remove source folders that end up empty (virtual in dry-run, real in apply).
  // Covers folder moves (archived/verification) and MIGRATION_RENAME sources (defer).
  const sourceFolders = new Set([...Object.keys(folderMoves)]);
  for (const fromRel of Object.keys(MIGRATION_RENAME)) sourceFolders.add(fromRel.split("/")[0]);
  for (const folder of sourceFolders) {
    const remain = docs.filter((d) => postRel(d.rel).startsWith(folder + "/"));
    if (remain.length === 0 && fs.existsSync(path.join(docRoot(), folder))) {
      actions.push({ from: `${folder}/`, to: "(removed)", note: "empty after moves" });
      if (apply) fs.rmdirSync(path.join(docRoot(), folder));
    }
  }

  // Duplicate-pair reconciliation flags - a decision, never a guess.
  for (const name of ["flutter-ui-regression-prevention.md", "server-driven-model-list.md"]) {
    if (
      fs.existsSync(path.join(docRoot(), "research", name)) &&
      fs.existsSync(path.join(docRoot(), "archive", name))
    ) {
      notes.push(`research/${name} and archive/${name} both exist - keep research copy active, or archive it?`);
    }
  }

  console.log(apply ? "--- ensure applied ---" : "--- ensure dry-run (re-run with --apply) ---");
  if (actions.length === 0) console.log("corpus already conformant - no changes");
  for (const a of actions) console.log(`  + ${a.from}${a.to ? ` -> ${a.to}` : ""}${a.note ? ` (${a.note})` : ""}`);
  if (notes.length) {
    console.log("\nnotes / need a decision:");
    for (const n of notes) console.log(`  ! ${n}`);
  }
  if (!apply) {
    console.log("\ndry-run: nothing was written.");
    return;
  }
  if (actions.length) {
    regenIndex(scanDocs());
    appendLog(`- ${today()}: ensure structure applied (${actions.length} change(s))`);
  }
  maybeSweep();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function help() {
  console.log(`agents-docs docs.js - deterministic bookkeeping for the .agents/docs corpus.

Usage: bun docs.js <command> [args] [flags]

  new <type> <title> [--area <area>]   create a doc from template (research|plan|worktree|bug|coverage)
  lookup <artifact>                    reverse-map a Lavish artifact to its source doc(s) via visual:
  visual <doc> <artifact>              register/update visual: on a doc (warn if not under .lavish/)
  sync <artifact> [--message <text>]   bump updated, append log.md, regen index.md for the mapped doc(s)
  status [--show-archive] [--show-orphan]  list docs by folder x area x status; flag stale / orphan / missing type
  report [--html [--out <path>]] [--check] [--show-archive] [--show-orphan]  derived status dashboard; --check exits 1 on unhealthy docs
  index                                regenerate index.md from frontmatter
  clean [--dry-run] [--apply] [--stale-orphan] [--force] [--ttl <days>]  auto-archive terminal/superseded docs and GC unreferenced archive docs
  prune [--dry-run|--apply] [--gc] [--ttl <days>] [--force]  propose archive moves; --gc lists archive deletions
  archive <doc> [--status=<v>]         move to archive/<type>-*.md, set terminal status, rewrite links, append log
  revive <archive-doc>                 restore an archived doc to its active folder with status: active
  scaffold-worktrees <plan-doc>        parse ## Worktree Strategy tracks from plan and create worktrees/*.md
  abandon <doc> [--status=<v>] [--dry-run]  one-step archive with the default terminal status for the doc's type
  ensure [--dry-run|--apply]           converge the 8-folder corpus onto the 6-folder structure (idempotent)

Environment: AGENTS_DOCS_ROOT overrides the corpus directory (used by tests).
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  switch (cmd) {
    case "new": return cmdNew(rest);
    case "lookup": return cmdLookup(rest);
    case "visual": return cmdVisual(rest);
    case "sync": return cmdSync(rest);
    case "status": return cmdStatus(rest);
    case "report": return cmdReport(rest);
    case "index": return regenIndex(scanDocs());
    case "clean": return cmdClean(rest);
    case "prune": return cmdPrune(rest);
    case "archive": return cmdArchive(rest);
    case "revive": return cmdRevive(rest);
    case "scaffold-worktrees": return cmdScaffoldWorktrees(rest);
    case "abandon": return cmdAbandon(rest);
    case "ensure": return cmdEnsure(rest);
    case "--help":
    case "help":
    case undefined:
      return help();
    default:
      die(`unknown command "${cmd}" (run "bun docs.js help")`, 2);
  }
}

main().catch((e) => {
  console.error(`docs.js: ${e.message || e}`);
  process.exit(1);
});
