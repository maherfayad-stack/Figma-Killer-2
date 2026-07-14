import { relative, sep } from 'node:path';
import type { Plugin, Rollup } from 'vite';
import { transformSourceUid } from './transform.js';

/** Studio-mode gate (playbook §4/P0 pitfall + ADR-0016 addendum): the
 * plugin MUST be a no-op unless studio dev mode is explicitly active, so a
 * standalone `pnpm dev` inside `files/<name>` (no studio env/config) stays
 * byte-identical to a P0 build — no `data-*` attrs, no bridge. The daemon
 * sets this env var when it boots a file-folder's Vite in studio mode
 * (see `packages/sync-daemon`'s additive boot hook). */
export const CCS_STUDIO_ENV_VAR = 'CCS_STUDIO';

export function isStudioModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CCS_STUDIO_ENV_VAR];
  return value === '1' || value === 'true';
}

export interface SourceUidPluginOptions {
  /** Force enable/disable regardless of `CCS_STUDIO` — mainly for tests and
   * for the daemon's studio-config layering (ADR-0016 addendum), which may
   * prefer an explicit option over relying solely on env propagation. When
   * omitted, falls back to `isStudioModeEnabled()`. */
  enabled?: boolean;
}

// Matches "*.tsx" and "*.tsx?<query>" (Vite appends query strings for HMR
// invalidation params etc.) but not ".tsx" appearing mid-path.
const TSX_FILE_RE = /\.tsx(\?.*)?$/;

/**
 * The Vite/Babel plugin (playbook §4/P2, ADR-0016 §1): tags every
 * JSXElement/JSXFragment in every `.tsx` file of the file-folder being
 * served with `data-uid`/`data-dynamic`/`data-component`, but ONLY when
 * studio mode is active.
 *
 * `enforce: 'pre'` is load-bearing: this must transform raw JSX source
 * BEFORE `@vitejs/plugin-react` (or esbuild's JSX loader) compiles JSX away
 * into `jsx()`/`createElement()` calls — after that point there are no
 * `JSXElement`/`JSXFragment` AST nodes left for us to find.
 */
export function sourceUidPlugin(options: SourceUidPluginOptions = {}): Plugin {
  const enabled = options.enabled ?? isStudioModeEnabled();
  let root = process.cwd();

  return {
    name: 'ccs:source-uid',
    enforce: 'pre',

    configResolved(config) {
      root = config.root;
    },

    transform(code, id) {
      if (!enabled) return null;
      if (id.includes('node_modules')) return null;
      if (!TSX_FILE_RE.test(id)) return null;

      const cleanId = id.split('?')[0] ?? id;
      const relPath = relative(root, cleanId).split(sep).join('/');

      // Skip anything Vite resolves outside the project root (virtual
      // modules, monorepo-external files, etc.) — relPath must be a clean
      // file-folder-relative path to satisfy NodeUidSchema and the P3
      // node-addressing contract.
      if (relPath.startsWith('..') || relPath === '') return null;

      const { code: transformed, map } = transformSourceUid(code, {
        relPath,
        filename: cleanId,
      });

      // Babel's source-map shape is structurally compatible with Rollup's
      // `SourceMapInput` (version/sources/names/mappings/sourcesContent) but
      // isn't nominally the same type — narrow cast at this single Vite
      // boundary rather than coupling `transform.ts` (deliberately
      // Vite-agnostic, independently testable) to Vite's types.
      return { code: transformed, map: map as Rollup.SourceMapInput | null };
    },
  };
}
