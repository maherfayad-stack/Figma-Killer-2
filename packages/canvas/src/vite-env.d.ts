/// <reference types="vite/client" />

/**
 * Sub-workstream 2d-ii (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — makes
 * `import.meta.env.VITE_CCS_CANVAS_ENGINE` (read once, at module scope, by
 * `StudioCanvas.tsx`'s dispatcher) typecheck under this package's OWN
 * `tsconfig.json` (`pnpm typecheck`'s first `tsc -p tsconfig.json` step,
 * whose `include` is just `"src"` — `dev/vite-env.d.ts`'s identical
 * reference only reaches `dev/tsconfig.json`'s wider `include`, not this
 * one). Every consumer that actually SERVES this package's `src/*.tsx`
 * through a real Vite dev/build (this package's own `dev/*` harnesses,
 * `apps/studio`'s own build) already defines/replaces `import.meta.env.*`
 * at bundle time regardless of this file — this is purely a typings-only
 * addition, changes no runtime behavior, and leaks no new dependency (`vite`
 * is already a devDependency of this package).
 */
