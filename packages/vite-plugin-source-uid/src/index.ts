/**
 * @ccs/vite-plugin-source-uid — Babel/Vite plugin tagging every
 * JSXElement/JSXFragment with `data-uid`/`data-dynamic`/`data-component` in
 * studio dev mode only (playbook §4/P2, node-addressing §1, ADR-0016).
 *
 * Public API:
 *  - `sourceUidPlugin()` — the Vite plugin, layered into a file-folder's
 *    Vite config by the daemon's studio-mode boot hook
 *    (`packages/sync-daemon`). No-ops unless `CCS_STUDIO` is set (or
 *    `{enabled:true}` is passed explicitly).
 *  - `deriveUidPaths()` / `createUidPathTracker()` — the canonical astPath
 *    derivation algorithm (see `uid-path.ts` for the full contract P3 must
 *    port against ts-morph).
 *  - `transformSourceUid()` / `createSourceUidBabelPlugin()` — the
 *    lower-level Babel transform, useful for testing or for tooling that
 *    wants the tagging behavior without going through Vite.
 */
export {
  sourceUidPlugin,
  isStudioModeEnabled,
  CCS_STUDIO_ENV_VAR,
  type SourceUidPluginOptions,
} from './vite-plugin.js';

export {
  transformSourceUid,
  type TransformSourceUidOptions,
  type TransformSourceUidResult,
} from './transform.js';

export {
  createSourceUidBabelPlugin,
  DATA_UID_ATTR,
  DATA_DYNAMIC_ATTR,
  DATA_COMPONENT_ATTR,
} from './babel-plugin.js';

export {
  deriveUidPaths,
  createUidPathTracker,
  type UidPathTracker,
  type DerivedUidPathEntry,
  type JsxPathNode,
} from './uid-path.js';

export { isDynamicJsxNode } from './dynamic.js';

export { resolveComponentTag, type ResolvedComponentTag } from './component-resolution.js';
