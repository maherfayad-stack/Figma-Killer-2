/**
 * layoutEdit — G-8: the one place that knows which Next `layout`/`template`
 * file the user has explicitly chosen to edit.
 *
 * A route-chrome node (`app/layout.tsx:12:5`) is composed into every route
 * below it, so a structural gesture on it is refused (`route-chrome`,
 * `sourceStructure.ts`): the write has one target, but the change lands in N
 * frames the user did not point at. "Edit layout" is the explicit opt-in — the
 * layout counterpart of "Edit main component" (`mainEditMode.ts` holds the one
 * mode both share). While the mode names a file, the placement rule stops
 * refusing nodes of THAT file, and only that file: another layout, a template,
 * a shared component and a `.map` row all refuse exactly as before.
 *
 * The mode lives in the editor store; this module holds the one fact the PURE
 * placement rule needs from it — the same shape as
 * `markSoleInstanceComponentFile` beside it, and for the same reason: the rule
 * is asked from places that have no store (the drag preview, the plugin
 * dispatcher, the codemods). The store's `setMainEditTarget` is the only
 * writer. Nothing on the server ever sets it, so a server-side
 * `refusePlacement` (`extractSubtreeToComponent`) keeps refusing layouts.
 */
import type { Page } from './page'
import { decodeSourceNodeId, isRouteChromeNodeId } from './sourceNodeId'

let editedLayoutRel: string | null = null

/** Set by the store when the "Edit layout" mode starts or ends. */
export function setEditedLayoutFile(rel: string | null): void {
  editedLayoutRel = rel
}

/** True for a node of the layout file the user chose to edit — and only that one. */
export function isEditedLayoutNodeId(nodeId: string): boolean {
  return editedLayoutRel !== null && isRouteChromeNodeId(nodeId) && decodeSourceNodeId(nodeId)?.rel === editedLayoutRel
}

/** The `layout`/`template` file a route-chrome node is written in, or `null` for any other node. */
export function layoutFileOf(nodeId: string): string | null {
  return isRouteChromeNodeId(nodeId) ? (decodeSourceNodeId(nodeId)?.rel ?? null) : null
}

/** Per page: the layout files it renders. Keyed by the page's `nodes` object, which a write replaces. */
const layoutsOfPage = new WeakMap<object, ReadonlySet<string>>()

function layoutsIn(page: Pick<Page, 'nodes'>): ReadonlySet<string> {
  const cached = layoutsOfPage.get(page.nodes)
  if (cached) return cached
  const files = new Set<string>()
  for (const id of Object.keys(page.nodes)) {
    const rel = layoutFileOf(id)
    if (rel !== null) files.add(rel)
  }
  layoutsOfPage.set(page.nodes, files)
  return files
}

/** How many routes (pages on the board) render the layout file `rel` — the N in "Edit layout (N routes)". */
export function layoutRouteCount(pages: readonly Pick<Page, 'nodes'>[], rel: string): number {
  let routes = 0
  for (const page of pages) if (layoutsIn(page).has(rel)) routes += 1
  return routes
}
