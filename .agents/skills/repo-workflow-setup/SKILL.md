---
name: repo-workflow-setup
description: Configure repository workflow automation (pre-commit, pre-push, merge queue, Worktrunk hooks, static-analysis gate). Triggers: repo onboarding or workflow changes.
---

# repo-workflow-setup

One-time bootstrap for repository workflow automation.
Wires together focused skills so each tool stays responsible for its own domain.

## Scope

This skill sets up:

- **Pre-commit hooks** - delegate to `/setup-pre-commit`.
- **Pre-push hooks** - optional checks before `git push`.
- **Worktrunk hooks** - delegate to `/worktrunk` for worktree lifecycle hooks.
- **Static-analysis gate** - delegate to `/fallow` (and language-specific tooling).
- **GitHub merge queue** - repository ruleset + CI trigger.

Everything is optional. Pick only the pieces the repo needs.

## GitHub merge queue

### When to enable

Enable merge queue when:

- The repo is on GitHub.
- Multiple independent PRs are open at the same time.
- You want CI to validate the combined state before merging.

Do not enable it when:

- The repo is not on GitHub.
- The maintainer prefers manual merges.
- PRs are mostly dependent/stacked (use `/gh-stack` instead).

### How to enable

1. Open the repository on GitHub.
2. Go to **Settings > Rules > Rulesets**.
3. Create or edit a ruleset targeting the default branch (`main` or `master`).
4. Check **Require merge queue**.
5. Disable **Allow administrators to bypass configured protection rules** so the queue cannot be skipped with `--admin`.
6. Ensure the CI workflow triggers on `merge_group`:

    ```yaml
    on:
      pull_request:
        branches: [main]
      merge_group:
        branches: [main]
    ```

7. Open a trivial PR to confirm it enters the queue and merges.

### Add a PR to the queue

```bash
gh pr merge <pr-number> --squash --auto
```

Or, if checks are already green:

```bash
gh pr merge <pr-number> --merge-queue
```

### Consumer skills

Skills that land PRs should be queue-aware:

- `/review-gate` - add the PR to the queue when the target branch uses one; otherwise leave merge to the user.
- `/branch-based-release` - release PRs queue like any other PR when a queue is enabled.
- `/worktrunk-orca-delegation` - independent tracks queue directly to the target branch when a queue is enabled.

## Pre-commit hooks

See `/setup-pre-commit`.

For vision-proxy, the pre-commit runs lint-staged, typecheck, and tests.

## Pre-push hooks

Pre-push hooks are optional. They catch issues that pre-commit misses, such as:

- Long-running tests.
- Integration tests that need network or services.
- Secret scans over the full history.

Example `.husky/pre-push`:

```bash
pnpm run test:integration
pnpm secrets
```

## Worktrunk hooks

See `/worktrunk`.

Use `post-start` and `pre-remove` hooks to isolate runtime resources for parallel worktrees (ports, databases, containers).

## Static-analysis gate

See `/fallow`.

Run `fallow audit --format json --quiet --explain --gate-marker agent` before committing AI-generated changes.

## Completion criteria

A `/repo-workflow-setup` run is complete when:

- the requested pieces are configured,
- each configured piece has a smoke test or verification command,
- the user knows which pieces are enabled and which are skipped.
