/**
 * Resolve a node by id across every page and (when active) the open Visual
 * Component tree. Studio's board mode renders several pages simultaneously —
 * unlike `selectSelectedNode`, which only looks at the single active
 * document — so this searches the whole site rather than assuming the
 * selected node lives on the active page.
 *
 * Reads `_nodeIdToPageIds` (WS-5.2) instead of scanning every page: O(1) map
 * lookup plus an O(pages) `find` to resolve the winning page object (pages
 * are not separately id-indexed; a linear find over a handful-to-tens of
 * pages is negligible next to the O(pages*nodes) scan this replaces).
 *
 * A node id is NOT unique across pages — a composed Next.js `layout.tsx`
 * node shares one id across every route beneath it (`STATE.md` → `meta-05`)
 * — so `_nodeIdToPageIds` is many-valued. When the id is present on several
 * pages, prefer the ACTIVE page: the inspector is anchored to a selection on
 * the canvas, and the canvas shows the active page's copy of that node. Only
 * fall back to the first indexed page when the active page isn't one of the
 * matches (e.g. selection changed pages between renders).
 *
 * Lives in its own module (not inline in `InPlaceInspector.tsx`) purely so
 * it can be a named export next to a component file — `react-refresh/
 * only-export-components` forbids a `.tsx` component module from also
 * exporting a plain function.
 */
import type { EditorStore } from '@site/store/store'
import type { BaseNode } from '@core/page-tree'

export function findNodeById(state: EditorStore, nodeId: string): BaseNode | null {
  if (!state.site) return null

  const pageIds = state._nodeIdToPageIds.get(nodeId)
  if (pageIds && pageIds.length > 0) {
    const preferredPageId = pageIds.includes(state.activePageId ?? '')
      ? state.activePageId
      : pageIds[0]
    const page = state.site.pages.find((p) => p.id === preferredPageId)
    const node = page?.nodes[nodeId]
    if (node) return node
  }

  const activeDocument = state.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const vc = state.site.visualComponents?.find((v) => v.id === activeDocument.vcId)
    const node = vc?.tree.nodes[nodeId]
    if (node) return node
  }
  return null
}
