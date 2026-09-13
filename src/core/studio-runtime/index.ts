// ---------------------------------------------------------------------------
// Barrel — the canonical public API for `@core/studio-runtime`.
//
// Deliberately does NOT re-export `vitePlugin.ts` or `idStamp.ts`. Both pull
// in `@babel/core`, which is fine inside the server-only sync script
// (`scripts/sync-studio-runtime.ts`) that bundles them into a workspace
// artifact, but would silently balloon the ADMIN bundle if this barrel ever
// re-exported them and admin code imported the barrel for something else.
// `liveNodeResolve.ts` (which the canvas WILL eventually import, once L4/L5
// build the bridge) mirrors `idStamp.ts`'s `STUDIO_NODE_ID_ATTR` literal
// rather than importing it for the identical reason — see that file's header.
//
// Gated by `src/__tests__/architecture/babel-not-in-admin-bundle.test.ts`.
// ---------------------------------------------------------------------------

export {
  buildStampIndex,
  resolveLiveNode,
  toStampId,
  STUDIO_NODE_ID_ATTR,
} from './liveNodeResolve'
export type { LiveElementLike, LiveNodeMatch, ResolveLiveNodeOptions } from './liveNodeResolve'

export {
  STUDIO_PARENT_ORIGIN_ENV,
  STUDIO_PROJECT_KEY_ENV,
  StudioRuntimeConfigSchema,
  readStudioRuntimeConfigFromEnv,
} from './runtimeConfig'
export type { StudioRuntimeConfig } from './runtimeConfig'
