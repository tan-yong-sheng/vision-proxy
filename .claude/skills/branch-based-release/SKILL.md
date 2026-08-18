---
name: branch-based-release
description: Branch-based release/pre-release convention for vision-proxy. Use when cutting a release, preparing a pre-release, or updating the release automation.
---
# branch-based-release

Release vision-proxy from `main` using a branch-based, auto-tagging workflow.

## Conventions

| Branch prefix | Example | Purpose |
|---|---|---|
| `release/v*` | `release/v0.1.0` | Stable release. Merging to `main` creates `v0.1.0`, publishes GitHub release, and backfills `Formula/vision-proxy.rb` sha256 values. |
| `prerelease/v*` | `prerelease/v0.1.0-rc.1` | Pre-release. Merging to `main` creates `v0.1.0-rc.1` as a GitHub pre-release and skips the Homebrew formula update. |

The branch name is for human clarity only. The real release decision is made from `package.json`:

- A `version` containing `-` (for example `0.1.0-rc.1`) is treated as a pre-release.
- A plain semver `version` (for example `0.1.0`) is treated as stable.

## Release PR contents

A release/pre-release PR changes only version config files:

- `package.json` - bump `"version"`.
- `Formula/vision-proxy.rb` - bump `version "..."` for stable releases only.

No code, test, or documentation changes belong in a release PR.

## Workflow

### Stable release

```bash
git checkout -b release/v0.1.0 main
# Edit package.json -> "version": "0.1.0"
# Edit Formula/vision-proxy.rb -> version "0.1.0"
git add package.json Formula/vision-proxy.rb
git commit -m "release: v0.1.0"
git push -u origin release/v0.1.0
gh pr create --base main --title "release: v0.1.0" --body "Bumps version to v0.1.0."
gh pr merge --squash --admin
```

Merging triggers `.github/workflows/auto-tag.yml`, which reads `package.json`, creates the `v0.1.0` tag, and calls `.github/workflows/release.yml` via `workflow_call`.

### Pre-release

```bash
git checkout -b prerelease/v0.1.0-rc.1 main
# Edit package.json -> "version": "0.1.0-rc.1"
git add package.json
git commit -m "prerelease: v0.1.0-rc.1"
git push -u origin prerelease/v0.1.0-rc.1
gh pr create --base main --title "prerelease: v0.1.0-rc.1" --body "Bumps version to v0.1.0-rc.1."
gh pr merge --squash --admin
```

The workflow creates `v0.1.0-rc.1` as a GitHub pre-release and does not update the Homebrew formula.

## Why `workflow_call`

A tag created with the default `GITHUB_TOKEN` cannot trigger another workflow. Therefore `auto-tag.yml` creates the tag and immediately calls `release.yml` through `workflow_call` instead of relying on `on: push: tags`.

## Failure handling

- If the release workflow fails after the tag is created, re-run the failed `release.yml` workflow manually from the Actions tab using the existing tag.
- If the tag already exists on `main` (no version bump), `auto-tag.yml` exits without releasing.

## See also

- [REFERENCE.md](REFERENCE.md) - workflow inputs, events, and conditions.
- `.github/workflows/auto-tag.yml`
- `.github/workflows/release.yml`
