// Shared helpers. Extracted from docs.js with zero behavior change.

import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, docRoot } from "./corpus.js";
import { extractOutbound, resolveTarget } from "./links.js";

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function kebab(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function fmt(rel) {
  return path.relative(REPO_ROOT, rel) || ".";
}

export function die(msg, code = 1, prog = "docs.js") {
  console.error(`${prog}: ${msg}`);
  process.exit(code);
}

export function fail(msg) {
  throw new Error(msg);
}

// Find a doc from a user-supplied reference: a docs-relative path, or a bare
// filename (with or without area prefix) resolved by substring within a folder.
export function findDoc(docs, ref) {
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

export function appendLog(line) {
  const logPath = path.join(docRoot(), "log.md");
  const header = "# agents-docs log\n\nAppend-only lifecycle journal; oldest at top, newest at bottom.\n\n";
  let text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : header;
  text = text.replace(/\n*$/, "") + "\n" + line + "\n";
  fs.writeFileSync(logPath, text);
}

export function relativeFrom(originAbs, targetAbs) {
  let rel = path.relative(path.dirname(originAbs), targetAbs);
  if (process.platform === "win32") rel = rel.split("\\").join("/");
  return rel.startsWith(".") ? rel : "./" + rel;
}

export function renderHref(newAbs, fromAbs, originalHref) {
  if (originalHref.startsWith(".agents/")) return fmt(newAbs);
  if (originalHref.startsWith("/")) return "/" + path.relative(REPO_ROOT, newAbs);
  return relativeFrom(fromAbs, newAbs);
}

// Rewrite all outbound links in `text` (authored at fromAbs) that point at a doc
// in `moves` (absOld -> absNew), preserving the referencing style.
export function rewriteOutbound(text, fromAbs, moves) {
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
