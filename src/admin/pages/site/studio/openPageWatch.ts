/**
 * openPageWatch — keeps `cssInsertDestination.ts`'s open-page anchor in step
 * with the board (Z8).
 *
 * `resolveCssInsertDestination` uses the page the user is LOOKING AT as the
 * co-location anchor for a class that is on no element yet. The save path
 * republishes that fact itself (`collectStyleRuleEdits`'s `activePageId`), so
 * a write never depends on a subscription having fired — but the save path is
 * not the only reader. `StyleTargetChip`/`resolveClassCssEditability` ask the
 * SAME resolver during render, and `classCssWriteLockReason` greys out every
 * property row for a class it believes has no destination. Left to the save
 * path alone, a user who opened a page and then created a class would be
 * locked out of typing the first value — which is the one thing that would
 * have triggered the save that fixed it.
 *
 * So the anchor is published when it CHANGES, not when it is used. One
 * subscription, no unsubscribe: the fact lives as long as the editor session
 * does, exactly like `localizedPageWriteback.ts`'s
 * `watchLocalizedPagesForBaseline`, whose shape (and idempotence) this
 * follows.
 *
 * Its own module rather than a few lines in `fsCodemodAdapter.ts` because
 * `cssInsertDestination.ts` must not import the editor store — it is read by
 * the Properties panel, by the class-token speller and by the baseline, and a
 * store import there would put the composed store in all three import graphs.
 */
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { resolveOpenPageFile, setOpenPageFile } from './cssInsertDestination'

/** Whether the subscription below is already live — see `watchOpenPageForCssDestination`. */
let watching = false

/**
 * Publishes the open page's source file for the document `pages` describes,
 * and keeps publishing on every page switch after. Idempotent: safe to call
 * on every `loadSite`, subscribes exactly once.
 *
 * Both halves are needed and neither covers the other. `pages` is passed in
 * because a load publishes BEFORE the store has adopted the new document —
 * the adapter holds it, the store does not yet — and a reload that keeps the
 * same page open (`loadSite` deliberately preserves it) changes no store
 * field a subscription could hang off, while the page→file mapping behind it
 * has just been re-parsed. The subscription covers the opposite case: a page
 * switch, where the store is the only thing that moved.
 */
export function watchOpenPageForCssDestination(pages: readonly Page[]): void {
  setOpenPageFile(resolveOpenPageFile(pages, useEditorStore.getState().activePageId))
  if (watching) return
  watching = true
  useEditorStore.subscribe(
    (state) => state.activePageId,
    (activePageId) => {
      setOpenPageFile(resolveOpenPageFile(useEditorStore.getState().site?.pages ?? [], activePageId))
    },
  )
}
