/**
 * packageModuleId — the single naming scheme for a generic npm-package
 * component's editor module id (WS-3.3, `STUDIO-IMPORT-V2-PLAN.md` §3.3):
 * `pkg.<sanitized-package>.<ComponentName>` — namespaced so two packages
 * exporting a component with the same name (`Button`) coexist in the
 * registry without colliding.
 *
 * Shared between the SERVER (`studioPageLoad.ts`'s `resolveModuleId`, which
 * decides what a parsed component node's `PageNode.moduleId` is;
 * `componentBundle.ts`'s barrel generation, which needs the identical
 * sanitized-package fragment for its own local export aliases) and the
 * CLIENT (`registerProjectModules.ts`, which must register a module under
 * the EXACT id the page tree already assigned it). Two independent string
 * templates in two files would drift the moment either side changed —
 * this is the one honest source.
 */

/** `@acme/ui` -> `_acme_ui`, `acme-ui` -> `acme_ui` — a valid identifier fragment. */
export function sanitizePackageName(pkg: string): string {
  return pkg.replace(/[^A-Za-z0-9]/g, '_')
}

/** The full namespaced module id a package's component `componentName` registers under. */
export function packageModuleId(pkg: string, componentName: string): string {
  return `pkg.${sanitizePackageName(pkg)}.${componentName}`
}

/**
 * Overlay/portal component NAMES the insert palette hides by heuristic — they
 * render detached from the canvas flow and are confusing to place by hand
 * (mirrors `src/modules/alm/register.tsx`'s hardcoded `PALETTE_HIDDEN_COMPONENTS`
 * list for the one `@alm-design/design-system` carve-out). Shared between the
 * CLIENT (`registerProjectModules.ts`, which unions this with
 * `.studio/meta.json`'s `paletteHiddenModuleIds` override to decide what the
 * live palette shows) and the SERVER (`studio_list_components`/
 * `studio_find_component` MCP tools, which report the same hidden verdict
 * headlessly so an agent can see it without an open editor). One regex, one
 * definition — the same reasoning `packageModuleId` above already gives for
 * why this lives here instead of being redeclared per consumer.
 */
export const PALETTE_HIDDEN_NAME_RE = /Dialog|Sheet|Modal|Toast|Snackbar|Tooltip|Popover/
