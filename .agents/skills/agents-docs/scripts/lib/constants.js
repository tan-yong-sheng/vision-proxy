// Shared constants for the agents-docs scripts (docs.js, evidence.js).
// Extracted from docs.js with zero behavior change.

// The 6 canonical lifecycle folders. `ensure` converges the tree to exactly these.
export const FOLDERS = ["research", "plans", "worktrees", "bugs", "qa", "archive"];

// Types map to a home folder for `new`.
export const TYPE_FOLDER = {
  research: "research",
  plan: "plans",
  worktree: "worktrees",
  bug: "bugs",
  coverage: "qa",
};

// Terminal (finished) statuses per type - the only statuses that justify archive.
export const TERMINAL_STATUS = {
  research: ["complete", "dead-end"],
  plan: ["complete", "dropped"],
  worktree: ["landed", "abandoned"],
  bug: ["fixed", "wontfix"],
  coverage: ["retired"],
};

export const AREAS = ["frontend", "backend", "fullstack"];

// Default status applied when `new` creates a doc of a given type.
export const DEFAULT_STATUS = {
  research: "active",
  plan: "active",
  worktree: "active",
  bug: "open",
  coverage: "active",
};

// Retention window for archive garbage collection (prune --gc). Days.
export const DEFAULT_TTL_DAYS = 180;

// Freshness threshold for active docs - older than this surfaces as stale. Days.
export const STALE_DAYS = 180;

// Type-specific stale thresholds. Shorter for ephemeral work; longer for evidence.
export const STALE_DAYS_BY_TYPE = {
  worktree: 14,
  research: 30,
  bug: 30,
  plan: 60,
  coverage: 90,
};

// Default terminal status applied by the `abandon` command per type.
export const ABANDON_STATUS = {
  research: "dead-end",
  plan: "dropped",
  worktree: "abandoned",
  bug: "wontfix",
  coverage: "retired",
};

// Docs with entry_point: true are intentionally top-level and do not flag as orphan.
export function isEntryPoint(doc) {
  return doc.fm.entry_point === true;
}
