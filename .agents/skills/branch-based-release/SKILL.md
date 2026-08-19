---
name: branch-based-release
description: Branch-based release/pre-release convention. Triggers for release, pre-release, or release-automation changes.
---
# branch-based-release

Release from the default branch using a branch-based, auto-tagging workflow.

## Conventions

| Branch prefix | Example | Purpose |
|---|---|---|
| `release/v*` | `release/v0.1.0` | Stable release. Merging to `main` creates `v0.1.0`, publishes GitHub release, and backfills `Formula/vision-proxy.rb` sha256 values. |
| `prerelease/v*` | `prerelease/v0.1.0-rc.1` | Pre-release. Merging to `main` creates `v0.1.0-rc.1` as a GitHub pre-release and skips the Homebrew formula update. |

The branch name is for human clarity only. The real release decision is made from `package.json`:

- A `version` containing `-` (for example `0.1.0-rc.1`) is treated as a pre-release.
- A plain semver `version` (for example `0.1.0`) is treated as stable.

## Release PR contents

A release/pre-release PR changes only version config files.
Examples:

- `package.json` - bump `"version"`.
- `Formula/<project>.rb` - bump `version "..."` for stable releases only.
- `Cargo.toml`, `pyproject.toml`, or a plain `VERSION` file for other ecosystems.

No code, test, or documentation changes belong in a release PR.

## Enforcement

A release/pre-release branch must be limited to version config changes.
Anything else is a release-process violation and should be rejected or moved to a feature branch.

### Allowed files

| Branch type | Allowed changes (example) |
|---|---|
| `release/v*` | canonical version file + packaging metadata (e.g. `package.json`, `Formula/<project>.rb`) |
| `prerelease/v*` | canonical version file only |

The Homebrew formula is skipped for pre-releases because pre-releases are not installable through the default curl installer or Homebrew tap.

### Validation before committing

After editing version files and before committing, run:

```bash
git diff --name-only
```

The output must contain only the allowed files for the branch type. If any other file appears, revert it or move it to a separate feature branch.

You can also enforce this in CI with a path filter on release PRs. See the workflow setup section below.

## Workflow

### Stable release

```bash
git checkout -b release/v0.1.0 <default-branch>
# Edit the canonical version file(s), e.g.:
#   package.json -> "version": "0.1.0"
#   Formula/<project>.rb -> version "0.1.0"
git add <version-files>
git commit -m "release: v0.1.0"
git push -u origin release/v0.1.0
gh pr create --base <default-branch> --title "release: v0.1.0" --body "Bumps version to v0.1.0."
# If the target branch uses a merge queue:
gh pr merge --squash --auto
# Otherwise:
# gh pr merge --squash
```

Merging triggers the release automation (for example `.github/workflows/auto-tag.yml`), which reads the canonical version source, creates the `v0.1.0` tag, and calls the release workflow via `workflow_call`.

> To configure a merge queue, see `/repo-workflow-setup`.

### Pre-release

```bash
git checkout -b prerelease/v0.1.0-rc.1 <default-branch>
# Edit the canonical version file, e.g.:
#   package.json -> "version": "0.1.0-rc.1"
git add <version-file>
git commit -m "prerelease: v0.1.0-rc.1"
git push -u origin prerelease/v0.1.0-rc.1
gh pr create --base <default-branch> --title "prerelease: v0.1.0-rc.1" --body "Bumps version to v0.1.0-rc.1."
# If the target branch uses a merge queue:
gh pr merge --squash --auto
# Otherwise:
# gh pr merge --squash
```

The workflow creates `v0.1.0-rc.1` as a GitHub pre-release and does not update the Homebrew formula.

## Setting up branch-based release in a new repository

To reuse this convention in another project, copy and adapt the following pieces.

### 1. Required files

Copy these files from the vision-proxy repo and adjust names/paths:

- `.github/workflows/auto-tag.yml`
- `.github/workflows/release.yml`

If the project ships a Homebrew formula, also create:

- `Formula/<project>.rb`

### 2. Version source

Ensure the workflows read the version from a single source of truth. vision-proxy uses `package.json`. For other ecosystems you may read from:

- `Cargo.toml` for Rust,
- `pyproject.toml` for Python,
- a dedicated `VERSION` file for generic projects.

Update `auto-tag.yml` to parse that source and pass it to `release.yml`.

### 3. Release artifacts

Edit `release.yml` to build and publish the artifacts your project needs. vision-proxy builds cross-platform tarballs and publishes a GitHub release. Replace the build matrix and artifact upload steps with whatever fits your project.

### 4. Branch protection and CI enforcement

Add a CI job that fails a release PR if it changes anything other than the allowed version files:

```yaml
jobs:
  verify-release-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Verify release PR only changes version files
        run: |
          changed=$(git diff --name-only origin/${{ github.base_ref }}...HEAD)
          allowed="<version-file>"
          if [ "${{ startsWith(github.head_ref, 'release/') }}" = "true" ]; then
            allowed="<version-file> <packaging-file>"
          fi
          for f in $changed; do
            if [[ " $allowed " != *" $f "* ]]; then
              echo "Release PR must not change $f" >&2
              exit 1
            fi
          done
```

### 5. Local scripts

Add helper scripts so humans can cut releases without remembering the file list:

- `scripts/bump-version.sh` - edit `package.json` (and formula for stable releases).
- `scripts/release.sh` - create the branch, push, and open the PR.

Keep these scripts minimal; the automation does the real work after the PR merges.

## Why `workflow_call`

A tag created with the default `GITHUB_TOKEN` cannot trigger another workflow. Therefore `auto-tag.yml` creates the tag and immediately calls `release.yml` through `workflow_call` instead of relying on `on: push: tags`.

## Failure handling

- If the release workflow fails after the tag is created, re-run the failed `release.yml` workflow manually from the Actions tab using the existing tag.
- If the tag already exists on `main` (no version bump), `auto-tag.yml` exits without releasing.

## See also

- [REFERENCE.md](REFERENCE.md) - workflow inputs, events, and conditions.
- `.github/workflows/auto-tag.yml`
- `.github/workflows/release.yml`
