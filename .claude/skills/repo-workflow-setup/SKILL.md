---
name: repo-workflow-setup
description: Bootstrap repository workflow guardrails. Triggers: repo onboarding or workflow changes.
---

# repo-workflow-setup

One-time bootstrap for repository workflow guardrails.
Delegates each concern to its focused skill.

## Scope

- **Pre-commit hooks** - `/setup-pre-commit`
- **Pre-push hooks** - optional checks before `git push`
- **Worktrunk hooks** - [`/worktrunk`](https://github.com/max-sixty/worktrunk)
- **Static-analysis gate** - [`/fallow`](https://github.com/fallow-rs/fallow) for TypeScript/JavaScript (and language-specific tooling for other ecosystems)
- **GitHub merge queue** - ruleset + CI trigger

Pick only the pieces the repo needs.

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

- `/review-gate` - add the PR to the queue when the target branch uses one.
- `/branch-based-release` - release PRs queue like any other PR when enabled.
- `/worktrunk-orca-delegation` - independent tracks queue directly to the target branch when enabled.

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

See [`/worktrunk`](https://github.com/max-sixty/worktrunk).

Use `post-start` and `pre-remove` hooks to isolate runtime resources for parallel worktrees (ports, databases, containers).

## Static-analysis gate

See [`/fallow`](https://github.com/fallow-rs/fallow) for TypeScript/JavaScript projects.

Run `fallow audit --format json --quiet --explain --gate-marker agent` before committing AI-generated changes.

## Completion criteria

A `/repo-workflow-setup` run is complete when:

- the requested guardrails are configured,
- each configured guardrail has a smoke test or verification command,
- the user knows which guardrails are enabled and which are skipped.
