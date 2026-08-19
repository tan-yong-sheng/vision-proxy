---
name: repo-workflow-setup
description: Bootstrap repository workflow guardrails. Triggers for repo onboarding or workflow changes.
---

# repo-workflow-setup

One-time bootstrap for repository workflow guardrails.
Delegates each concern to its focused skill.

## Scope

- **Pre-commit hooks** - `/setup-pre-commit`
- **Pre-push hooks** - optional checks before `git push`
- **Worktrunk hooks** - [`/worktrunk`](https://github.com/max-sixty/worktrunk)
- **Static-analysis gate** - [`/fallow`](https://github.com/fallow-rs/fallow) for TypeScript/JavaScript (and language-specific tooling for other ecosystems)

Pick only the pieces the repo needs.

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
