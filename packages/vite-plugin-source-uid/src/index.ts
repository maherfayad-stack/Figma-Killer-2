/**
 * packages/vite-plugin-source-uid — babel visitor tagging every JSXElement/
 * JSXFragment with `data-uid` (relPath + stable AST path), `data-dynamic`
 * (inside map/ternary/logical), `data-component` (resolved import, `ds:`
 * prefix for design-system origin). Runs only in studio dev mode. Scope:
 * Phase 2 (playbook §4/P2, §1 node-addressing section).
 */
export const VITE_PLUGIN_SOURCE_UID_PACKAGE_PHASE = 'P2' as const;

export function notImplementedYet(feature: string): never {
  throw new Error(`@ccs/vite-plugin-source-uid: "${feature}" is P2 scope, not implemented in P0`);
}
