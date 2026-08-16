// Link extraction + graph. Extracted from docs.js with zero behavior change.

import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "./corpus.js";

export const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
export const REPO_LINK_RE = /\.agents\/docs\/[\w./-]+\.md/g;

export function extractOutbound(text) {
  const out = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) out.push(m[1]);
  REPO_LINK_RE.lastIndex = 0;
  while ((m = REPO_LINK_RE.exec(text))) out.push(m[0]);
  return out;
}

export function resolveTarget(href, fromAbs) {
  const h = href.replace(/^</, "").replace(/>$/, "").split("#")[0].split("?")[0];
  if (!h || /^[a-z]+:/i.test(h) || h.startsWith("//")) return null;
  if (h.startsWith(".agents/")) return path.resolve(REPO_ROOT, h);
  if (h.startsWith("/")) return path.resolve(REPO_ROOT, h.slice(1));
  return path.resolve(path.dirname(fromAbs), h);
}

export function buildLinkGraph(docs) {
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
