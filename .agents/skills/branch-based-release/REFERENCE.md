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
| `0.1.0` | `v0.1.0` | No |
| `0.1.0-rc.1` | `v0.1.0-rc.1` | Yes |
| `0.2.0-beta.3` | `v0.2.0-beta.3` | Yes |

## Branch naming

Use these prefixes for clarity. The automation does not enforce them.

| Type | Prefix | Example |
|---|---|---|
| Stable | `release/` | `release/v0.1.0` |
| Pre-release | `prerelease/` | `prerelease/v0.1.0-rc.1` |
