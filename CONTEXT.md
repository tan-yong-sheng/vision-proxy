# CONTEXT.md

Domain glossary for vision-proxy. Terms here name good seams; architecture
reviews and refactors should use these names exactly.

## Terms

- **host-policy** — the shared context-file handoff policy (tempfile
  pipeline + quoting + analyze detect/append + `VP_*` policy) in
  `src/integrations/runtime.ts`, shipped via `HOOK_RUNTIME_SOURCE`;
  `hook-script.ts` and `pi-extension.ts` are thin adapters. The four hook
  settings (program path, timeout, token cap, off-switch) live in one
  `HOST_ENV` table; the shared off-switch check (`isAnalysisDisabled`) and
  live timeout/token readers (`resolveHookTimeout`,
  `resolveMaxOutputTokens`) serve both hosts, so `VP_MODE=off` stops the
  hook like Pi and timeout changes need no restart.
