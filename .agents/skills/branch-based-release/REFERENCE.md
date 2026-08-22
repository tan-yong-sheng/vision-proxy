# branch-based-release reference

## Workflows

### `.github/workflows/auto-tag.yml`

| Item | Value |
|---|---|
| Trigger | `push` to `main` |
| Job | `tag` |
| Output `tag` | The `v<version>` tag derived from `package.json` |
| Output `prerelease` | `true` when `package.json` version contains `-` |
| Output `created` | `true` when a new tag was pushed |

Steps:

1. Read `package.json` version.
2. Detect pre-release from the `-` character in the version.
3. Create and push the tag if it does not exist.
4. Call `release.yml` via `workflow_call` with `tag` and `prerelease` inputs.

### `.github/workflows/release.yml`

| Trigger | Purpose |
|---|---|
| `push: tags: - "v*"` | Manual tag pushes still run the release pipeline. |
| `workflow_dispatch` | Run the release for a specific tag and optional prerelease flag. |
| `workflow_call` | Called by `auto-tag.yml` so the auto-created tag does not need a second trigger. |

Inputs:

| Input | Type | Required | Default |
|---|---|---|---|
| `tag` | string | yes | - |
| `prerelease` | boolean | yes | - |

Jobs:

| Job | Runs | Key output |
|---|---|---|
| `build` | Matrix of OS/arch runners | Uploads per-arch tarball artifacts |
| `release` | `ubuntu-latest` | Publishes GitHub release and optionally commits formula sha256 |

Conditions in `release`:

- Formula checksum update and formula commit run only when `steps.meta.outputs.prerelease != 'true'`.
- `softprops/action-gh-release` receives `prerelease: ${{ steps.meta.outputs.prerelease == 'true' }}`.

## Pre-release detection

```bash
if [[ "$version" == *-* ]]; then
  prerelease="true"
fi
```

Examples:

| `package.json` version | Tag | Pre-release? |
|---|---|---|
| `0.1.1` | `v0.1.1` | No |
| `0.1.1-rc.1` | `v0.1.1-rc.1` | Yes |
| `0.2.0-beta.3` | `v0.2.0-beta.3` | Yes |

## Branch naming

Use these prefixes for clarity. The automation does not enforce them.

| Type | Prefix | Example |
|---|---|---|
| Stable | `release/` | `release/v0.1.1` |
| Pre-release | `prerelease/` | `prerelease/v0.1.1-rc.1` |

## Release PR enforcement

A release or pre-release PR must only change the allowed version config files.

### Allowed files

| Branch type | Allowed files |
|---|---|
| `release/v*` | `package.json`, `Formula/<project>.rb` |
| `prerelease/v*` | `package.json` |

### Local validation

```bash
# list files changed on the release branch
git diff --name-only main..release/v0.1.1
```

If the list includes anything outside the allowed files, revert or move it to a feature branch.

### CI enforcement

Add this job to `.github/workflows/ci.yml` or a dedicated `verify-release.yml`:

```yaml
verify-release-pr:
  if: startsWith(github.head_ref, 'release/') || startsWith(github.head_ref, 'prerelease/')
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - name: Verify release PR only changes version files
      run: |
        changed=$(git diff --name-only origin/${{ github.base_ref }}...HEAD)
        if [ "${{ startsWith(github.head_ref, 'release/') }}" = "true" ]; then
          allowed="package.json Formula/<project>.rb"
        else
          allowed="package.json"
        fi
        for f in $changed; do
          if [[ " $allowed " != *" $f "* ]]; then
            echo "Release PR must not change $f" >&2
            exit 1
          fi
        done
```

Replace `Formula/<project>.rb` with the actual formula path, or remove it if the project has no Homebrew formula.

## Release Notes & Changelog Generation

Use GitHub's release notes generation API to preview release notes and populate the PR description:

```bash
notes=$(gh api "repos/{owner}/{repo}/releases/generate-notes" -f tag_name="v0.1.1" -f previous_tag_name="$latest_tag" --jq .body)
```

This ensures reviewers see all merged PRs directly in the release PR before merging.
