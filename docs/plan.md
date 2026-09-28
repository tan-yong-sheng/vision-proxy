# Plan: grounding models

- Trigger: a new Google model needs grounding.
- Verify first: it actually emits 0–1000 normalized boxes (per-model capability, not provider-wide — that's why no `google/*` wildcard).
- Add one exact `google/<model-id>` entry in `DEFAULT_CONFIG.groundingModels` (`src/core.ts`).
- Add/extend the `getGroundingFormat` assertion in `src/core.test.ts`.
- Validate: `npm test`, `npx tsc --noEmit`, biome check.
