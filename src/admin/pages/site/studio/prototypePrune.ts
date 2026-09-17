/**
 * prototypePrune — dropping the links a page deletion just orphaned.
 *
 * DELETING A PAGE IS THE ONE EDIT THAT BREAKS A LINK WITHOUT TOUCHING THE
 * LINK'S OWN SOURCE. A link FROM the page and a link TO it both end up naming
 * something that is gone, and neither the serializer nor the `NodeHint`
 * re-resolution can notice: both are about an element INSIDE a page, and the
 * page is what went away. So it is an explicit op — and it has to be called
 * from the CLIENT, because `prune` carries the list of pages that still exist
 * and the server cannot enumerate those without parsing the project, which is
 * exactly the work the route exists to avoid.
 *
 * WHY THIS IS NOT IN `prototypeActions.ts`
 * ───────────────────────────────────────
 * Every other prototype round trip lives there, and this one would too if it
 * could. Its caller is `store/slices/site/pageActions.ts` — part of the editor
 * store — and `prototypeActions` imports the store, so putting it there makes a
 * real import cycle (`store → siteSlice → pageActions → prototypeActions →
 * store`), which `no-circular-dependencies.test.ts` catches.
 *
 * So this module TOUCHES NO STORE. It takes the links and the page list, does
 * the round trip, and hands the merged file back for the caller to adopt with
 * the `get()` it already has. That is the same shape `studioStructuralCommits`
 * has for the same reason — a store slice's collaborator has to be store-free.
 */
import { getErrorMessage } from '@core/utils/errorMessage'
import type { PrototypeFile, PrototypeLink } from '@core/studio-prototype'
import { applyPrototypeOp } from './prototypeApi'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'

/**
 * Whether deleting `pageId` orphans anything at all.
 *
 * Both halves of a link name a page, and only the SOURCE is the one whose hint
 * re-resolution would ever have noticed a change — so the target has to be
 * checked explicitly or a link INTO the deleted page survives it.
 */
export function linksOrphanedByPageDelete(
  links: readonly PrototypeLink[],
  pageId: string,
): boolean {
  return links.some((link) => link.source.pageId === pageId || link.targetPageId === pageId)
}

/**
 * Prune, and return the server's merged file — or `null` when there was
 * nothing to ask and nothing to adopt.
 *
 * Two refusals, both deliberate:
 *
 *   - **Nothing named the deleted page** — no round trip. A project with no
 *     prototype must not pay a request per page delete, and an op that changes
 *     nothing is a write the file does not need.
 *   - **No pages left to name** — no round trip. The server refuses an empty
 *     `prune` anyway (it is indistinguishable from a caller that failed to load
 *     its pages, and obeying it would wipe every flow in the project), so
 *     sending one would be asking for a 400 on purpose.
 *
 * A failure is logged, never toasted. The user deleted a page and it IS
 * deleted; a stale link draws nothing and the inspector already marks it, so a
 * red box about the flow file is noise on an operation that succeeded.
 */
export async function pruneLinksForDeletedPage(
  links: readonly PrototypeLink[],
  deletedPageId: string,
  remainingPageIds: readonly string[],
): Promise<PrototypeFile | null> {
  if (remainingPageIds.length === 0) return null
  if (!linksOrphanedByPageDelete(links, deletedPageId)) return null

  try {
    return await applyPrototypeOp(
      { kind: 'prune', pageIds: [...remainingPageIds] },
      getStudioWorkspaceDir(),
    )
  } catch (err) {
    console.error(
      '[prototypePrune] failed to prune links for a deleted page:',
      getErrorMessage(err, 'Unknown error pruning prototype links'),
    )
    return null
  }
}
