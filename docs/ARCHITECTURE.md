# Architecture

Module boundaries for `src/`, as established by the refactor series
(`5c99eb8` hook runtime + integration lifecycle, `a1ae6da` analysis
pipeline, `398f24e` CLI command runner). Each decision keeps a thin
compatibility surface so existing imports and tests keep working while
the implementation lives in a focused module. Seam tests pin every
boundary below.

## Shared standalone hook runtime

`src/hooks/runtime.ts` is the single home for the analysis policy shared
by every generated host artifact: image path classification, path
extraction, env parsing, reminder/instruction rendering, `vp` command
resolution, and analyze argument construction. Each host adapter
(`src/hook-script.ts` for Claude Code/Codex, `src/pi-extension.ts`,
`src/opencode-plugin.ts`) calls into this policy and owns only its
lifecycle translation (event shapes, image-cache refs, mode gating,
executors, deny/output shapes).

Standalone constraint: generated artifacts must run with no
vision-proxy package present (plain `npx tsx`, Pi jiti, opencode plugin
loader), so the module ships its policy in two shapes from one source
of truth: real functions (exercised directly by `src/hooks/runtime.test.ts`)
plus `HOOK_RUNTIME_SOURCE`, composed from those same functions via
`toString` and inlined into each emitted file at `generate()` time.
Functions composed into the source string follow the embedding
discipline (no backtick, no `${`, no imports beyond `node:os`/`node:path`
plus `process`, plain declarations with no `export`), enforced by golden
tests over the final artifacts (`src/hooks/generated-sources.test.ts`).

## Integration catalog and lifecycle

`src/integrations/` splits host knowledge from orchestration:

- `catalog.ts` owns every host-specific fact: artifact/config paths,
  generated file content (version marker + standalone source), the hook
  command written into host configs, and legacy cleanups. Host configs
  stay metadata-free (standard keys only).
- `lifecycle.ts` owns install/show/list/status/uninstall orchestration:
  artifact writes, config registration, empty-dir cleanup, version
  reporting, unknown-agent handling.
- `hooks-config.ts` owns the shared hooks-JSON shape for Claude Code
  and Codex; `types.ts` owns the shared types; `index.ts` is the public
  surface.
- `src/commands/integration.ts` only re-exports the module so CLI and
  test imports keep working.

Pinned by `src/integrations/catalog.test.ts`,
`src/integrations/hooks-config.test.ts`, and
`src/commands/integration.test.ts`.

## Analysis module

`src/analysis/` owns the `vp analyze` coordination flow:
`pipeline.ts` (`runAnalyze`: config resolution, image
intake/read/hash/crop, cache-first single + joint multi-image policy,
provider/model dispatch via the adapter, safe fenced rendering),
`types.ts` (the `AnalyzeFlags`/`AnalyzeOutcome` surface), `index.ts`
(the public surface). `core.ts`, `config.ts`, `cache.ts`,
`adapter.ts`, and `provider.ts` remain the focused implementation
files; `src/commands/analyze.ts` only re-exports the module so CLI and
test imports keep working.

Pinned by `src/analysis/seam.test.ts`: the command surface must be
referentially identical to the module surface, and coordination error
behavior (image limits, unknown providers, malformed crops) holds
without reaching the model.

## CLI command runner

`src/command-runner.ts` owns the command grammar and dispatch policy:
hand-rolled flag parsing, help lookup/rendering, subcommand routing,
and result/error mapping. It is side-effect free except through the
command modules it calls — it returns a structured
`{ stdout, stderr, code }` outcome and never touches `process.stdout`,
`process.stderr`, or `process.exitCode`. `src/cli.ts` stays the process
adapter (argv in, stdout/stderr/exit-code out, update-notifier setup),
and the public `parseFlags` surface is preserved by identity.

Pinned by `src/command-runner.test.ts`, including notifier-suppression
regression coverage.

## Deferred: image-primitive consolidation (Candidate 06)

Consolidating the image safety/crop/metadata/rendering primitives in
`src/core.ts` (`readImageFileWithReason`, `hashImageData`, `cropImage`,
`storeImageMeta`, the fence builders) into `src/analysis/` is
**deferred**. The current split stands: `core.ts` owns the primitives,
`analysis/` owns the coordination.

Reopen only when image-related changes *repeatedly* cross both files in
lockstep — e.g. crop, metadata, or rendering changes that require
paired edits to `core.ts` primitives and `pipeline.ts` coordination.
Occasional one-sided changes are not a trigger.
