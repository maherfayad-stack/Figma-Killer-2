/**
 * pageReadEpoch — "has this page been replaced by a re-read from disk since
 * that moment?", answered in O(pages asked about).
 *
 * The one reader is `structuralCommitRollback.ts` (ERR-6). A move or delete
 * mutates the tree the instant the gesture runs, then posts its write. When the
 * write does not land, the tree has to be taken back — by applying the
 * gesture's own inverse patches, which address the page by its position in
 * `site.pages` and its nodes by id. That is exact as long as the page the
 * patches were recorded against is still the one in the store. It is wrong
 * the moment a re-read replaced it: the fresh page already says what the file
 * says (the refused gesture is not in it), and replaying the inverse on top
 * would put back a node the file never lost, or move one the file never moved.
 *
 * Value edits made while the write was on the wire do NOT count: they touch
 * `props`/`inlineStyles`, never the `children`/`parentId` paths a move or
 * delete's inverse restores, and every other STRUCTURAL gesture is queued
 * behind the in-flight write (`structuralCommitQueue.ts`). A re-read is the
 * only thing that can pull the tree out from under the patches — so a re-read
 * is the only thing this module counts.
 *
 * `loadSite`, `createSite` and `clearSite` replace every page, and so does a
 * `patchPages` that REMOVES pages (the survivors' positions in `site.pages`
 * shift, which is what the patches address them by). A `patchPages` that only
 * upserts replaces exactly the pages it names.
 *
 * Module-level on purpose, like `structuralOptimism.ts`'s pending-id set: it
 * is bookkeeping about what the store's reload paths did, read by an async
 * commit that has no business subscribing to the store.
 */

let epoch = 0
/** The epoch of the last read that replaced EVERY page. */
let wholeSiteReadAt = 0
const pageReadAt = new Map<string, number>()

/** Now, as a mark to compare a later {@link pagesReadSince} against. */
export function pageReadMark(): number {
  return epoch
}

/** Called by the store's reload paths the moment they replace pages. `'all'` for a whole-site replacement. */
export function notePagesRead(pageIds: Iterable<string> | 'all'): void {
  epoch += 1
  if (pageIds === 'all') {
    wholeSiteReadAt = epoch
    pageReadAt.clear()
    return
  }
  for (const pageId of pageIds) pageReadAt.set(pageId, epoch)
}

/** Whether any of `pageIds` was replaced by a re-read after `mark` was taken. */
export function pagesReadSince(pageIds: Iterable<string>, mark: number): boolean {
  if (wholeSiteReadAt > mark) return true
  for (const pageId of pageIds) if ((pageReadAt.get(pageId) ?? 0) > mark) return true
  return false
}
