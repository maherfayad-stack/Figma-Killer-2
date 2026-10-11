/**
 * siteReloadApply — what the editor does with a re-read of the board, on both
 * paths: the narrow `patchPages` one and the full `loadSite` one.
 *
 * Split out of `usePersistence.ts` (which owns WHEN a re-read happens: the
 * listeners, the fetch, the sequence token) so the part worth pinning in a
 * test — "the write's result is what the board points at once its re-read
 * lands, and one ⌘Z undoes it" — is reachable without mounting the hook, and
 * so a test's stand-in listener runs the exact code the real one does rather
 * than a hand copy of it.
 */
import { useEditorStore } from '@site/store/store'
import type { PendingStructuralOutcome } from '@site/studio/pendingStructuralOutcome'
import type { CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { noteBoardRead } from '@site/studio/sourceIdentity'
import { readEditorSelectPreference } from '@site/preferences/editorPreferences'
import type { SiteLoadProgress } from '@core/persistence/types'

/**
 * `store-13`/`store-14` — apply what a structural source write means, now that
 * the board has read it back: put the selection on what it made or moved, and
 * give the gesture its undo entry.
 *
 * The outcome is the one that rode THIS re-read (ERR-10,
 * `pendingStructuralOutcome.ts`) — never one parked by a different write.
 *
 * Every id is checked against `_nodeIdToPageIds` (O(1) per id, the WS-5.2
 * index) before the SELECTION uses it, and a write whose elements did not come
 * back selects nothing at all rather than part of itself: a half-applied
 * selection points the inspector at one of several things the user just made,
 * which reads as the gesture having half-failed. The history entry is recorded
 * either way — a gesture whose result the board cannot point at was still
 * written to the file, and ⌘Z has to be able to take it back.
 */
export function applyStructuralWriteOutcome(outcome: PendingStructuralOutcome | null | undefined): void {
  if (!outcome) return
  const state = useEditorStore.getState()
  if (outcome.history) state.recordStructuralSourceWrite(outcome.history)
  const { selectNodeIds } = outcome
  if (selectNodeIds.length === 0) return
  if (!selectNodeIds.every((id) => state._nodeIdToPageIds.has(id))) return
  if (selectNodeIds.length === 1) state.selectNode(selectNodeIds[0]!)
  else state.selectMany([...selectNodeIds])
}

/**
 * The narrow re-read (`CMS_SITE_PAGES_PATCH_EVENT`): hand the fresh pages to
 * the store, then apply the outcome that travelled with them. Forwarded whole
 * rather than field-by-field: the registries travel with the pages they were
 * parsed alongside, and dropping them here is the bug the sender exists to
 * avoid.
 */
export function applySitePagesPatch(detail: CmsSitePagesPatchDetail): void {
  if (detail.canvasLayers) useEditorStore.getState().setCanvasLayers(detail.canvasLayers)
  useEditorStore.getState().patchPages({
    pages: detail.pages,
    removedPageIds: detail.removedPageIds,
    styleRules: detail.styleRules,
    conditions: detail.conditions,
  })
  // P1-A — record who every source position names, as just read, BEFORE the
  // outcome is applied: a gesture queued behind this write re-finds its ids from it.
  noteBoardRead(detail.pages, 'merge')
  applyStructuralWriteOutcome(detail.structuralOutcome)
}

/**
 * Apply the user's `defaultBreakpoint` preference if the loaded site declares
 * a matching breakpoint id. Falls back silently when the preference points to
 * a breakpoint the current site doesn't have (e.g. user previously edited a
 * site with a custom 'wide' breakpoint, then opened a site without it).
 */
export function applyDefaultBreakpointPreference(breakpoints: ReadonlyArray<{ id: string }>): void {
  const preferredId = readEditorSelectPreference('defaultBreakpoint')
  if (!breakpoints.some((bp) => bp.id === preferredId)) return
  useEditorStore.getState().setActiveBreakpoint(preferredId)
}

/** A streamed first open, as `usePersistence` drives it: the progress to hand the adapter, and whether it has opened. */
export interface StreamedOpen {
  progress: SiteLoadProgress
  opened(): boolean
}

/**
 * P6-B — the first open of a project, handed to the store as its pages arrive
 * (`streamedLoadSlice.ts`): the document with its first pages, then each later
 * batch. `live()` turns false once the load that owns this has been superseded
 * (an unmount, a newer load), after which nothing more reaches the store.
 * `onOpen` runs once the document is in the store — from then on it is the
 * document the editor edits and saves, while the rest is still arriving.
 */
/**
 * Performance-timeline marks for a project opening (P6-B): the document reaching
 * the store, and its last page arriving. `tests/e2e/studio-board-load.e2e.ts`
 * reads them; a person can too, in the Performance panel.
 */
export const STUDIO_LOAD_OPEN_MARK = 'studio:load:open'
export const STUDIO_LOAD_COMPLETE_MARK = 'studio:load:complete'

export function streamedOpenProgress(live: () => boolean, onOpen: () => void): StreamedOpen {
  let opened = false
  return {
    opened: () => opened,
    progress: {
      open(site, pending) {
        if (!live()) return
        opened = true
        useEditorStore.getState().openStreamedLoad(site, pending)
        noteBoardRead(site.pages, 'reset') // P1-A — who every source position names, as just read
        applyDefaultBreakpointPreference(site.breakpoints)
        onOpen()
        performance.mark(STUDIO_LOAD_OPEN_MARK, { detail: { pages: site.pages.length, pending: pending.length } })
      },
      pages(pages) {
        if (!live()) return
        useEditorStore.getState().receiveStreamedPages(pages)
        noteBoardRead(pages, 'merge')
      },
    },
  }
}
