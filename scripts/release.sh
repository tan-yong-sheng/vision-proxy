#!/usr/bin/env bash
set -euo pipefail

# scripts/release.sh
# Automates cutting a branch-based release or pre-release with deterministic semver.
#
# Usage:
#   ./scripts/release.sh patch          # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor          # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major          # 0.1.0 -> 1.0.0
#   ./scripts/release.sh rc             # 0.1.0 -> 0.1.1-rc.1 (or 0.1.1-rc.1 -> 0.1.1-rc.2)
#   ./scripts/release.sh 0.1.1          # Explicit version

BUMP_TYPE="${1:-}"

if [ -z "$BUMP_TYPE" ]; then
  echo "Usage: $0 <patch|minor|major|rc|custom-version>" >&2
  exit 1
fi

# Ensure working directory is clean
if ! git diff-index --quiet HEAD --; then
  echo "Error: Working directory has uncommitted changes. Please commit or stash first." >&2
  exit 1
fi

# Sync remote main and prune stale tags
echo "Fetching origin/main and pruning stale tags..."
git fetch origin main --tags --prune

# Determine latest published tag from GitHub Releases (canonical source of truth)
LATEST_TAG=$(gh release view --json tagName -q .tagName 2>/dev/null || echo "")
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
fi

echo "Latest published release tag: ${LATEST_TAG}"

# Calculate target version
TARGET_VERSION=$(node -e '
  const bump = process.argv[1];
  const latestTag = process.argv[2] || "v0.0.0";
  const current = latestTag.replace(/^v/, "");

  if (/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(bump)) {
    console.log(bump);
    process.exit(0);
  }

  const [base, pre] = current.split("-");
  const [major, minor, patch] = base.split(".").map(Number);

  if (bump === "patch") {
    console.log(`${major}.${minor}.${patch + 1}`);
  } else if (bump === "minor") {
    console.log(`${major}.${minor + 1}.0`);
  } else if (bump === "major") {
    console.log(`${major + 1}.0.0`);
  } else if (bump === "rc" || bump === "prerelease") {
    if (pre && pre.startsWith("rc.")) {
      const rcNum = Number(pre.slice(3)) + 1;
      console.log(`${base}-rc.${rcNum}`);
    } else {
      console.log(`${major}.${minor}.${patch + 1}-rc.1`);
    }
  } else {
    console.error(`Unknown bump type: ${bump}`);
    process.exit(1);
  }
' "$BUMP_TYPE" "$LATEST_TAG")

echo "Target version: ${TARGET_VERSION}"

# Determine release kind and branch prefix
if [[ "$TARGET_VERSION" == *-* ]]; then
  IS_PRERELEASE="true"
  PREFIX="prerelease"
  BRANCH="prerelease/v${TARGET_VERSION}"
else
  IS_PRERELEASE="false"
  PREFIX="release"
  BRANCH="release/v${TARGET_VERSION}"
fi

echo "Creating branch ${BRANCH} from origin/main..."
git checkout -b "${BRANCH}" origin/main

# Update package.json
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, "\t") + "\n");
' "$TARGET_VERSION"

# Update Formula/vision-proxy.rb if stable release
if [ "$IS_PRERELEASE" = "false" ] && [ -f "Formula/vision-proxy.rb" ]; then
  node -e '
    const fs = require("node:fs");
    const content = fs.readFileSync("Formula/vision-proxy.rb", "utf8");
    const updated = content.replace(/version "[^"]+"/, `version "${process.argv[1]}"`);
    fs.writeFileSync("Formula/vision-proxy.rb", updated);
  ' "$TARGET_VERSION"
fi

# Validate that only version files are modified
echo "Validating changed files..."
CHANGED=$(git diff --name-only)
for f in $CHANGED; do
  if [ "$f" != "package.json" ] && [ "$f" != "Formula/vision-proxy.rb" ]; then
    echo "Error: Unexpected file modified: $f" >&2
    exit 1
  fi
done

# Commit version changes
git add package.json
if [ "$IS_PRERELEASE" = "false" ] && [ -f "Formula/vision-proxy.rb" ]; then
  git add Formula/vision-proxy.rb
fi

git commit -m "${PREFIX}: v${TARGET_VERSION}"
git push -u origin "${BRANCH}"

# Generate changelog preview for PR description
echo "Generating changelog preview..."
if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "v0.0.0" ]; then
  NOTES=$(gh api "repos/{owner}/{repo}/releases/generate-notes" \
    -f tag_name="v${TARGET_VERSION}" \
    -f previous_tag_name="${LATEST_TAG}" \
    --jq .body 2>/dev/null || echo "Bumps version to v${TARGET_VERSION}.")
else
  NOTES=$(gh api "repos/{owner}/{repo}/releases/generate-notes" \
    -f tag_name="v${TARGET_VERSION}" \
    --jq .body 2>/dev/null || echo "Bumps version to v${TARGET_VERSION}.")
fi

# Create PR
echo "Opening pull request..."
gh pr create \
  --base main \
  --title "${PREFIX}: v${TARGET_VERSION}" \
  --body "$NOTES"

echo "Release PR created successfully for v${TARGET_VERSION}."
