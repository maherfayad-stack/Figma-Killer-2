/**
 * Page mutation actions: addPage, deletePage, renamePage, duplicatePage,
 * reorderPages, convertPageToTemplate, convertTemplateToPage.
 *
 * `deletePage` is the one action here that reaches past the in-memory document.
 * In Studio the repository IS the page, so splicing it out of `site.pages` and
 * stopping there is not a delete — the `.tsx` survives and the next reload
 * parses it straight back in. The store is the right place to commit the
 * source write for the same reason `deleteNodesAction.ts` commits its own: it
 * is the chokepoint every surface already runs through (the explorer's context
 * menu, its multi-select bulk delete, spotlight, the agent executor), so one
 * commit here is one commit for all of them.
 */

import {
  type Page,
  addPage,
  deletePage,
  renamePage,
  reorderPages,
  duplicatePage,
  reconcileSiteExplorerInPlace,
} from '@core/page-tree'
import { isStudioPageRootId } from '@core/page-tree'
import { deleteStudioPage } from '@site/studio/studioPageRequests'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { SiteSlice, SiteSliceHelpers } from './types'
import { clearCanvasSelectionDraft } from '../selectionSlice'

/**
 * Delete `pageId`'s source file, reporting failure honestly.
 *
 * Fire-and-forget from the caller's point of view (the tree mutation already
 * landed optimistically, exactly like `commitStudioDelete`'s), but a FAILED
 * delete reloads: the page is still on disk, so leaving the canvas showing it
 * gone would put the board back in the "shows something the files do not say"
 * state that `studioSaveRequests.ts` catalogues as audit finding E3. Reloading
 * puts the page back where the user can see it and try again.
 */
async function commitStudioPageDeletion(pageId: string): Promise<void> {
  try {
    await deleteStudioPage(pageId)
  } catch (err) {
    console.error('[pageActions] delete page failed:', err)
    pushToast({
      kind: 'error',
      title: 'Could not delete page',
      body: getErrorMessage(err, 'Unknown page error'),
    })
    requestCmsSiteReload()
  }
}

type PageActions = Pick<
  SiteSlice,
  | 'addPage'
  | 'deletePage'
  | 'renamePage'
  | 'duplicatePage'
  | 'reorderPages'
  | 'convertPageToTemplate'
  | 'convertTemplateToPage'
>

export function createPageActions({
  get,
  set,
  mutateSite,
}: SiteSliceHelpers): PageActions {
  return {
    addPage: (title, slug) => {
      let newPage!: Page
      mutateSite((p) => {
        newPage = addPage(p, title, slug ?? title)
        reconcileSiteExplorerInPlace(p)
        return true
      })
      set((state) => {
        state.activePageId = newPage.id
        clearCanvasSelectionDraft(state)
      })
      return newPage
    },

    deletePage: (pageId) => {
      // Read the page BEFORE the mutation: whether it is a studio page is a
      // question about its root node id (a source location, not a nanoid), and
      // after the splice there is no page left to ask.
      const page = get().site?.pages.find((candidate) => candidate.id === pageId)
      const isStudioPage = page !== undefined && isStudioPageRootId(page.rootNodeId)

      const deleted = mutateSite((p) => {
        if (!p.pages.some((page) => page.id === pageId)) return false
        deletePage(p, pageId)
        reconcileSiteExplorerInPlace(p)
        return true
      })
      if (!deleted) return

      const { site, activePageId } = get()
      if (activePageId === pageId && site) {
        set((state) => { state.activePageId = site.pages[0]?.id ?? null })
      }

      if (!isStudioPage) return
      // The board is the page's other half. Dropping its frames here rather
      // than waiting for the reload keeps the canvas honest for the round trip
      // — and marks `boardsPendingExplicitRemoval`, which is what tells
      // `boardsSaveGuard.ts` that this shrink was asked for rather than a
      // symptom of a bad load, so the boards autosave is not refused.
      get().removeFrame(pageId)
      void commitStudioPageDeletion(pageId)
    },

    renamePage: (pageId, title, slug) => {
      mutateSite((p) => {
        const page = p.pages.find((candidate) => candidate.id === pageId)
        if (!page) return false
        renamePage(p, pageId, title, slug)
        return true
      })
    },

    duplicatePage: (sourcePageId, title, slug) => {
      let newPage!: Page
      mutateSite((p) => {
        newPage = duplicatePage(p, sourcePageId, title, slug)
        reconcileSiteExplorerInPlace(p)
        return true
      })
      return newPage
    },

    reorderPages: (fromIndex, toIndex) => {
      mutateSite((p) => {
        if (fromIndex === toIndex) return false
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= p.pages.length ||
          toIndex >= p.pages.length
        ) {
          return false
        }
        reorderPages(p, fromIndex, toIndex)
        return true
      })
    },

    convertPageToTemplate: (pageId, config) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return false
        page.template = config
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },

    convertTemplateToPage: (pageId) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return false
        const hadTemplate = page.template !== undefined
        const hadDynamicBindings = Object.values(page.nodes).some(
          (node) => node.dynamicBindings !== undefined,
        )
        if (!hadTemplate && !hadDynamicBindings) return false
        delete page.template
        for (const node of Object.values(page.nodes)) {
          delete node.dynamicBindings
        }
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },
  }
}
