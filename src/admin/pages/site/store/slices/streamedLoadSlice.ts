/**
 * streamedLoadSlice — a project opening while its pages are still arriving
 * (P6-B, PERF-7).
 *
 * A project's `/load` stream carries its pages one line at a time, the frames
 * a person sees first, first (`studioLoadResponse.ts`). Opening the board used
 * to wait for the last line; now the document is handed to the store as soon
 * as the first page is in (`openStreamedLoad`), each later batch is appended
 * as it arrives (`receiveStreamedPages`), and `pendingPages` names the pages
 * still on the wire, which is what lets a board frame whose page has not
 * arrived paint a placeholder instead of vanishing (`BoardFramesLayer.tsx`).
 *
 * ## Appended, never inserted
 *
 * Every undo entry is a Mutative patch that addresses its page by POSITION in
 * `site.pages` (`historyTypes.ts`), and so does an in-flight structural
 * write's rollback (`pageReadEpoch.ts`). A page arriving is therefore only
 * ever APPENDED: nothing already in the document moves while the user may be
 * editing it. The pages go back into page order in `finishStreamedLoad`, and
 * only when nothing positional exists to protect (an empty undo stack — every
 * edit, and every structural write in flight, has an entry). A user who edited
 * inside the stream's window keeps the arrival order until the next load;
 * nothing is lost, only the page list's order differs.
 *
 * ## Not an edit
 *
 * Like `patchPages`, these actions record no history and mark nothing dirty:
 * the pages were just read from disk, and a save of them would write back what
 * the file already says. The same holds for `adoptLoadedFramework`: the token
 * extraction a load runs after itself, whose answer is part of the read.
 */
import { create } from 'mutative'
import { reconcileSiteExplorerInPlace, reindexNodeParents } from '@core/page-tree'
import type { Page, SiteDocument } from '@core/page-tree'
import type { PendingPage } from '@core/persistence/types'
import type { EditorStoreSliceCreator } from '@site/store/types'
import { emptyDirtyMarks } from './site/dirtyTracking'
import { reconcileFrameworkClasses } from './site/framework/reconcile'
import { applyNodeIndexPatch, nodeIndexesOf, rebuildNodeIndexes } from './site/nodeIndex'
import { notePagesRead } from './site/pageReadEpoch'

export interface StreamedLoadSlice {
  /** Pages a load has announced but not delivered yet, in the order they will arrive. Empty outside a streamed load. */
  pendingPages: PendingPage[]
  /** The first delivery: `loadSite` with the pages that have arrived, and the rest marked pending. */
  openStreamedLoad: (site: SiteDocument, pending: readonly PendingPage[]) => void
  /** Later pages of the same load, appended to `site.pages`. */
  receiveStreamedPages: (pages: readonly Page[]) => void
  /** The load delivered its last page: nothing is pending, and the pages go back into `pageOrder` when that is safe (module doc). */
  finishStreamedLoad: (pageOrder: readonly string[]) => void
  /** The load failed or was superseded after it opened: whatever never arrived is no longer on its way. */
  abandonStreamedLoad: () => void
  /**
   * The token extraction a load runs AFTER it (`studioProjectLoad.ts`'s
   * `adoptExtractedTokens`) landed: take its framework as part of what was
   * read — like `loadSite`, no history, no dirty mark, and the framework
   * classes reconciled — unless the document no longer holds the framework
   * the load gave it (the person changed it meanwhile; theirs stands). Returns
   * whether the document now holds `extracted`.
   */
  adoptLoadedFramework: (loaded: SiteDocument['settings']['framework'], extracted: SiteDocument['settings']['framework']) => boolean
}

declare module '@site/store/types' {
  interface EditorStore extends StreamedLoadSlice {}
}

const NO_PENDING_PAGES: PendingPage[] = []

export const createStreamedLoadSlice: EditorStoreSliceCreator<StreamedLoadSlice> = (set, get) => ({
  pendingPages: NO_PENDING_PAGES,

  openStreamedLoad: (site, pending) => {
    get().loadSite(site)
    set((state) => {
      state.pendingPages = pending.length > 0 ? [...pending] : NO_PENDING_PAGES
    })
  },

  receiveStreamedPages: (arrived) => {
    const { site } = get()
    if (!site || arrived.length === 0) return
    const present = new Set(site.pages.map((page) => page.id))
    const fresh = arrived.filter((page) => !present.has(page.id))
    if (fresh.length === 0) return
    for (const page of fresh) reindexNodeParents(page.nodes)
    const nextSite: SiteDocument = { ...site, pages: [...site.pages, ...fresh] }
    reconcileSiteExplorerInPlace(nextSite)
    const freshIds = new Set(fresh.map((page) => page.id))
    notePagesRead(freshIds)
    set((state) => {
      const marks = emptyDirtyMarks()
      for (const id of freshIds) marks.pageIds.add(id)
      state.site = nextSite
      applyNodeIndexPatch(nodeIndexesOf(state), site, nextSite, marks)
      const stillPending = state.pendingPages.filter((page) => !freshIds.has(page.id))
      state.pendingPages = stillPending.length > 0 ? stillPending : NO_PENDING_PAGES
    })
  },

  finishStreamedLoad: (pageOrder) => {
    const { site, _historyPast, _historyFuture } = get()
    const ordered = site && _historyPast.length === 0 && _historyFuture.length === 0 ? inPageOrder(site.pages, pageOrder) : null
    set((state) => {
      state.pendingPages = NO_PENDING_PAGES
      if (!site || !ordered) return
      const nextSite: SiteDocument = { ...site, pages: ordered }
      reconcileSiteExplorerInPlace(nextSite)
      state.site = nextSite
    })
    // Every page's position may have moved. Nothing holds a position now (the
    // stack is empty), but a reader of the epoch must still hear it.
    if (ordered) notePagesRead('all')
  },

  abandonStreamedLoad: () => {
    if (get().pendingPages.length === 0) return
    set((state) => {
      state.pendingPages = NO_PENDING_PAGES
    })
  },

  adoptLoadedFramework: (loaded, extracted) => {
    const { site } = get()
    if (!site) return false
    const held = JSON.stringify(site.settings.framework)
    if (held === JSON.stringify(extracted)) return true
    if (held !== JSON.stringify(loaded)) return false
    // What `loadSite` does with the framework it is handed: regenerate the
    // framework classes, and re-point any class ids they claim or prune.
    const next = create(site, (draft) => {
      draft.settings.framework = extracted
      reconcileFrameworkClasses(draft as SiteDocument)
    })
    set((state) => {
      state.site = next
      rebuildNodeIndexes(nodeIndexesOf(state), next)
    })
    return true
  },
})

/** `pages` sorted into `pageOrder` (unknown ids last, in their current order), or `null` when they already are. */
function inPageOrder(pages: readonly Page[], pageOrder: readonly string[]): Page[] | null {
  const rank = new Map(pageOrder.map((id, index) => [id, index]))
  const rankOf = (page: Page) => rank.get(page.id) ?? pageOrder.length
  const sorted = [...pages].sort((a, b) => rankOf(a) - rankOf(b))
  return sorted.every((page, index) => page === pages[index]) ? null : sorted
}
