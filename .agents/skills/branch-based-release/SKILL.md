---
name: branch-based-release
description: Branch-based release/pre-release convention. Triggers for release, pre-release, or release-automation changes.
---
# branch-based-release

Release from the default branch using a branch-based, auto-tagging workflow.

## Conventions

| Branch prefix | Example | Purpose |
|---|---|---|
| `release/v*` | `release/v0.1.1` | Stable release. Merging to `main` creates `v0.1.1`, publishes GitHub release, and backfills `Formula/vision-proxy.rb` sha256 values. |
| `prerelease/v*` | `prerelease/v0.1.1-rc.1` | Pre-release. Merging to `main` creates `v0.1.1-rc.1` as a GitHub pre-release and skips the Homebrew formula update. |

The branch name is for human clarity only.
The real release decision is made from `package.json`:

- A `version` containing `-` (for example `0.1.1-rc.1`) is treated as a pre-release.
- A plain semver `version` (for example `0.1.1`) is treated as stable.

## Version Discovery & Semantic Versioning

To avoid version hallucinations or stale local git tag confusion:

1. **Always query the remote release as the source of truth**:
   Do not rely on local `git tag -l` which may contain stale, unpushed tags.
   Fetch and prune remote tags:
   ```bash
   git fetch origin main --tags --prune
   ```
   Query the latest published release tag:
   ```bash
   latest_tag=$(gh release view --json tagName -q .tagName 2>/dev/null || echo "v0.0.0")
   ```

2. **Increment according to Semantic Versioning**:
   - `patch` (bug fixes, docs, maintenance): `0.1.0` -> `0.1.1`
   - `minor` (new backwards-compatible features): `0.1.0` -> `0.2.0`
   - `major` (breaking changes): `0.1.0` -> `1.0.0`
   - `prerelease` / `rc`: `0.1.0` -> `0.1.1-rc.1` (or `0.1.1-rc.1` -> `0.1.1-rc.2`)

## Release PR Contents & Enforcement

A release/pre-release PR changes **only version config files**.

### Allowed files

| Branch type | Allowed changes |
|---|---|
| `release/v*` | canonical version file + packaging metadata (e.g. `package.json`, `Formula/<project>.rb`) |
| `prerelease/v*` | canonical version file only (`package.json`) |

No code, test, or documentation changes belong in a release PR.

### Validation before committing

After editing version files and before committing, run:

```bash
git diff --name-only
```

The output must contain only the allowed files for the branch type.
If any other file appears, revert it or move it to a separate feature branch.

## Automated Workflow (Recommended)

Use `scripts/release.sh` to automatically compute the next semver, edit version files, validate constraints, generate changelog notes, and open the PR:

```bash
# Cut a patch release (e.g. 0.1.0 -> 0.1.1)
./scripts/release.sh patch

# Cut a minor release (e.g. 0.1.0 -> 0.2.0)
./scripts/release.sh minor

# Cut a pre-release (e.g. 0.1.0 -> 0.1.1-rc.1)
./scripts/release.sh rc

# Cut a specific version
./scripts/release.sh 0.1.1
```

## Manual Workflow

If cutting a release manually, follow these steps:

### Stable release

```bash
# 1. Fetch latest release and sync
git fetch origin main --tags --prune
latest_tag=$(gh release view --json tagName -q .tagName 2>/dev/null || echo "v0.0.0")

# 2. Create release branch
git checkout -b release/v0.1.1 origin/main

# 3. Edit canonical version files
#   package.json -> "version": "0.1.1"
#   Formula/<project>.rb -> version "0.1.1"

# 4. Verify only version files changed
git diff --name-only

# 5. Commit and push
git add package.json Formula/vision-proxy.rb
git commit -m "release: v0.1.1"
git push -u origin release/v0.1.1

# 6. Generate changelog preview for PR description
notes=$(gh api "repos/{owner}/{repo}/releases/generate-notes" -f tag_name="v0.1.1" -f previous_tag_name="$latest_tag" --jq .body)

# 7. Create PR with changelog notes
gh pr create --base main --title "release: v0.1.1" --body "$notes"
gh pr merge --squash
```

Merging triggers the release automation (`.github/workflows/auto-tag.yml`), which reads `package.json`, creates the `v0.1.1` tag, and calls `release.yml` via `workflow_call`.

### Pre-release

```bash
# 1. Fetch latest release and sync
git fetch origin main --tags --prune
latest_tag=$(gh release view --json tagName -q .tagName 2>/dev/null || echo "v0.0.0")

# 2. Create pre-release branch
git checkout -b prerelease/v0.1.1-rc.1 origin/main

# 3. Edit canonical version file
#   package.json -> "version": "0.1.1-rc.1"

# 4. Verify only version file changed
git diff --name-only

# 5. Commit and push
git add package.json
git commit -m "prerelease: v0.1.1-rc.1"
git push -u origin prerelease/v0.1.1-rc.1

# 6. Generate changelog preview for PR description
notes=$(gh api "repos/{owner}/{repo}/releases/generate-notes" -f tag_name="v0.1.1-rc.1" -f previous_tag_name="$latest_tag" --jq .body)

# 7. Create PR with changelog notes
gh pr create --base main --title "prerelease: v0.1.1-rc.1" --body "$notes"
gh pr merge --squash
```

The workflow creates `v0.1.1-rc.1` as a GitHub pre-release and skips the Homebrew formula update.

## Setting up branch-based release in a new repository

To reuse this convention in another project, copy and adapt the following pieces:

1. **Required workflows**: `.github/workflows/auto-tag.yml`, `.github/workflows/release.yml`.
2. **Formula (optional)**: `Formula/<project>.rb`.
3. **Helper script**: `scripts/release.sh`.
4. **CI path enforcement**: Add a check that release PRs only touch allowed version files.

## Failure handling

- If the release workflow fails after the tag is created, re-run the failed `release.yml` workflow manually from the Actions tab using the existing tag.
- If the tag already exists on `main` (no version bump), `auto-tag.yml` exits without releasing.

## See also

- [REFERENCE.md](REFERENCE.md) - workflow inputs, events, and conditions.
- `.github/workflows/auto-tag.yml`
- `.github/workflows/release.yml`
