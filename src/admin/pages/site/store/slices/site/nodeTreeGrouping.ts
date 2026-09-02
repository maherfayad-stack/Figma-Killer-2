/**
 * nodeTreeGrouping — WS-7.3 helper split out of `helpers.ts` (which was
 * pushing the 700-line module-size budget). Pure — no `set`/`get` closure —
 * so it lives on its own rather than inside `buildSiteHelpers`.
 */
import type { EditorStore } from '@site/store/types'

/**
 * Which page each of `nodeIds` belongs to, per `_nodeIdToPageIds` (WS-5.2).
 * Many-valued: a shared/composed id (an inlined component instance, or
 * Next.js route chrome — `meta-05`) appears under every page that contains
 * it, so it lands in every one of those pages' buckets, in encounter order.
 * An id absent from the index (never indexed, or VC-only) is simply
 * dropped — nothing to act on for it in page-tree terms.
 */
export function groupNodeIdsByPage(
  state: Pick<EditorStore, '_nodeIdToPageIds'>,
  nodeIds: string[],
): Map<string, string[]> {
  const byPage = new Map<string, string[]>()
  for (const id of nodeIds) {
    for (const pageId of state._nodeIdToPageIds.get(id) ?? []) {
      const bucket = byPage.get(pageId)
      if (bucket) bucket.push(id)
      else byPage.set(pageId, [id])
    }
  }
  return byPage
}
