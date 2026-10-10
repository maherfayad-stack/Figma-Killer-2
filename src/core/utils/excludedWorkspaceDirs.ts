/**
 * Directory names a workspace walk never descends into, anywhere in the tree.
 *
 * Its own dependency-free leaf — NOT in `page-parser/workspaceFiles.ts` where
 * the server-side walk lives — because the browser needs the list too (the
 * launcher's dropped-folder walk), and `@core/page-parser`'s barrel drags
 * `ts-morph` and `node:fs` into the editor bundle. One list: `workspaceFiles.ts`
 * re-exports this very set, so the client walk and the server walk cannot
 * disagree about what "app code" is.
 */
export const EXCLUDED_WORKSPACE_DIR_NAMES: ReadonlySet<string> = new Set([
  '.studio', // editor-owned spatial metadata (boards.json) — not app code
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.turbo',
])
