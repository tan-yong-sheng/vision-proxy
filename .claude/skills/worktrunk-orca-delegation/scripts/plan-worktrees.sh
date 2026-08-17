#!/usr/bin/env bash
# plan-worktrees.sh
# Read worktree flight logs and emit a deterministic JSON plan for
# worktrunk-orca-delegation to spawn feature worktrees, merge-preview worktrees,
# and review surfaces.

set -euo pipefail

WORKTREE_DOCS_DIR=".agents/docs/worktrees"

if [ ! -d "$WORKTREE_DOCS_DIR" ]; then
  echo '{"feature_worktrees":[],"merge_previews":[],"review_surfaces":[],"errors":["No worktree docs directory found"]}'
  exit 1
fi

node --input-type=module - "$WORKTREE_DOCS_DIR" <<'NODE'
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const worktreeDocsDir = process.argv[2];

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;
  const yaml = match[1];
  const fm = {};

  const scalar = (key) => {
    const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : undefined;
  };

  const list = (key) => {
    const lines = yaml.split("\n");
    const result = [];
    let inBlock = false;
    for (const line of lines) {
      const header = new RegExp(`^${key}:\\s*\\[?\\s*$`).test(line);
      const item = line.match(/^\s*-\s*(.+)$/);
      if (header) {
        inBlock = true;
        if (line.includes("[")) {
          const inline = line.match(/\[([^\]]*)\]/);
          if (inline) {
            return inline[1]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          }
        }
        continue;
      }
      if (inBlock && item) {
        result.push(item[1].trim());
        continue;
      }
      if (inBlock && !line.startsWith(" ") && !line.startsWith("-")) {
        break;
      }
    }
    return result.length ? result : undefined;
  };

  fm.branch = scalar("branch");
  fm.pr_strategy = scalar("pr_strategy");
  fm.combined_with = list("combined_with");
  fm.review_worktree = scalar("review_worktree");
  fm.depends_on = list("depends_on");
  fm.stack_batch = scalar("stack_batch");
  return fm;
}

const entries = [];
const errors = [];

for (const file of readdirSync(worktreeDocsDir)) {
  if (!file.endsWith(".md")) continue;
  const path = join(worktreeDocsDir, file);
  const text = readFileSync(path, "utf8");
  const fm = parseFrontmatter(text);
  if (!fm) {
    errors.push(`${path}: missing frontmatter`);
    continue;
  }
  if (!fm.branch) {
    errors.push(`${path}: missing branch field`);
    continue;
  }
  entries.push({ ...fm, file });
}

const byBranch = new Map(entries.map((e) => [e.branch, e]));

for (const e of entries) {
  if (e.pr_strategy === "combined") {
    if (!e.combined_with || e.combined_with.length === 0) {
      errors.push(`${e.file}: pr_strategy=combined requires combined_with`);
      continue;
    }
    if (!e.review_worktree) {
      errors.push(`${e.file}: pr_strategy=combined requires review_worktree`);
      continue;
    }
    for (const other of e.combined_with) {
      const otherEntry = byBranch.get(other);
      if (!otherEntry) {
        errors.push(`${e.file}: combined_with branch '${other}' has no worktree doc`);
        continue;
      }
      if (otherEntry.pr_strategy !== "combined") {
        errors.push(`${e.file}: combined_with branch '${other}' must also have pr_strategy=combined`);
      }
      if (!otherEntry.combined_with?.includes(e.branch ?? e.worktree)) {
        errors.push(`${e.file}: combined_with branch '${other}' does not list this branch back`);
      }
      if (otherEntry.review_worktree !== e.review_worktree) {
        errors.push(`${e.file}: combined_with branch '${other}' has a different review_worktree`);
      }
    }
  }
}

const featureWorktrees = entries.map((e) => e.branch);

const mergePreviewMap = new Map();
for (const e of entries) {
  if (e.review_worktree) {
    if (!mergePreviewMap.has(e.review_worktree)) {
      mergePreviewMap.set(e.review_worktree, new Set());
    }
    mergePreviewMap.get(e.review_worktree).add(e.branch);
    for (const other of e.combined_with ?? []) {
      const otherEntry = byBranch.get(other);
      if (otherEntry) {
        mergePreviewMap.get(e.review_worktree).add(otherEntry.branch);
      }
    }
  }
}

const mergePreviews = [];
for (const [worktree, branches] of mergePreviewMap) {
  mergePreviews.push({ worktree, branches: [...branches] });
}

const reviewSurfaces = entries.map((e) => ({
  branch: e.branch,
  review_worktree: e.review_worktree ?? null,
}));

const plan = {
  feature_worktrees: featureWorktrees,
  merge_previews: mergePreviews,
  review_surfaces: reviewSurfaces,
  errors,
};

console.log(JSON.stringify(plan, null, 2));
if (errors.length > 0) {
  process.exit(1);
}
NODE
