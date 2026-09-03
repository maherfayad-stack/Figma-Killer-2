/**
 * SiteDocument lifecycle actions: createSite, loadSite, clearSite, updateSiteName.
 */

import { findHomePage, reconcileSiteExplorerInPlace, reindexNodeParents } from '@core/page-tree'
import type { Page, SiteDocument } from '@core/page-tree'
import { removeFramesForPage } from '@core/studio-board'
import { renderCache } from '@site/canvas/renderCache'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
} from '@core/site-dependencies/manifest'
import {
  cloneSiteRuntimeConfig,
  DEFAULT_SITE_RUNTIME,
} from '@core/site-runtime'
import { pushToast } from '@ui/components/Toast'
import { clearCanvasSelectionDraft } from '../selectionSlice'
import { createDefaultSiteDocument } from './defaults'
import { emptyDirtyMarks, type DirtyMarks } from './dirtyTracking'
import { reconcileFrameworkClasses } from './framework/reconcile'
import { collectAllNodeIds, historySurvivesReload } from './historyPreservation'
import { applyNodeIndexPatch, clearNodeIndexes, rebuildNodeIndexes } from './nodeIndex'
import { applyProjectDefaultViewport } from '../projectDefaultViewport'
import type { SiteSlice, SiteSliceHelpers } from './types'

type LifecycleActions = Pick<
  SiteSlice,
  'createSite' | 'loadSite' | 'clearSite' | 'updateSiteName' | 'patchPages'
>

/**
 * Derive the `parentId` index for every page tree and Visual Component tree in
 * a site about to be hydrated into the store. Sites reach `loadSite` already
 * validated (the persistence layer reindexes on parse) OR hand-assembled (tests,
 * `createDefaultSiteDocument`); reindexing here is idempotent and guarantees the
 * O(1) `getParent` pointer is consistent before any mutation runs.
 */
function reindexSiteTreeParents(site: SiteDocument): void {
  for (const page of site.pages) reindexNodeParents(page.nodes)
  for (const vc of site.visualComponents ?? []) reindexNodeParents(vc.tree.nodes)
  for (const layout of site.layouts ?? []) reindexNodeParents(layout.nodes)
}

export function createLifecycleActions({
  set,
  get,
  mutateSite,
}: SiteSliceHelpers): LifecycleActions {
  return {
    createSite: (name) => {
      const site = createDefaultSiteDocument(name)
      reconcileSiteExplorerInPlace(site)
      reindexSiteTreeParents(site)
      const siteRuntime = cloneSiteRuntimeConfig(site.runtime)
      set((state) => {
        state.site = { ...site, runtime: siteRuntime }
        state.packageJson = clonePackageJson(site.packageJson)
        state.siteRuntime = siteRuntime
        // Default to the home page (slug `index`) so the editor opens on `/`
        // rather than whatever happens to be first in the array.
        state.activePageId = (findHomePage(site.pages) ?? site.pages[0]).id
        // Reset activeDocument — any previously-open VC reference belongs to
        // the prior site and would cause `mutateActiveTree` to silently no-op
        // (early-return) when the VC id is not present in the new site.
        state.activeDocument = null
        state._historyPast = []
        state._historyFuture = []
        state._historyCoalesceKey = null
        state.canUndo = false
        state.canRedo = false
        state.hasUnsavedChanges = false
        // A brand-new site has no stored rows at all — first save is full.
        state._dirtySave = { ...emptyDirtyMarks(), all: true }
        // Fresh site, fresh indexes — cheap (one page) and simplest-correct.
        // `site` (the local, pre-spread var) has the same `pages` as
        // `state.site` — the spread above only overrides `runtime`.
        rebuildNodeIndexes(
          {
            nodeIdToPageIds: state._nodeIdToPageIds,
            textOriginKeyToCount: state._textOriginKeyToCount,
            inlineTailToCount: state._inlineTailToCount,
          },
          site,
        )
      })
      return site
    },

    loadSite: (site) => {
      // Clear the render cache BEFORE store hydration so stale HTML from a previous
      // site cannot bleed into the canvas after switching projects.
      // (Guideline #307 / Architect message #1216 — critical integration note)
      renderCache.clear()
      reconcileFrameworkClasses(site)
      reconcileSiteExplorerInPlace(site)
      reindexSiteTreeParents(site)
      const packageJson = clonePackageJson(site.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(site.runtime)
      // 0.2 (E2) fix — computed against the INCOMING site (pure, no draft
      // needed) before deciding, inside `set()` below, whether the current
      // `_historyPast`/`_historyFuture` can survive this reload intact. See
      // `historyPreservation.ts`'s doc for what "safe" means and why a
      // structural-edit reload no longer has to destroy the whole undo stack.
      const knownNodeIds = collectAllNodeIds(site)
      set((state) => {
        const historySafe =
          historySurvivesReload(state._historyPast, knownNodeIds) &&
          historySurvivesReload(state._historyFuture, knownNodeIds)

        state.site = { ...site, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        // Default to the home page (slug `index`) so the editor opens on `/`
        // rather than whatever happens to be first in the array — EXCEPT when
        // this load is a re-sync of the document already open, rather than a
        // switch to a different one. Studio re-parses the whole workspace from
        // disk after a writeback that moved line numbers or touched a shared
        // component, and resetting the active page there threw the designer back
        // to the home page mid-edit, seconds after an unrelated keystroke. A page
        // id still present in the incoming site is the same page, so keep it; on
        // a genuine project switch no id matches and this falls through to home.
        const openPageId = state.activePageId
        const openPageStillExists =
          openPageId !== null && site.pages.some((page) => page.id === openPageId)
        state.activePageId = openPageStillExists
          ? openPageId
          : (findHomePage(site.pages) ?? site.pages[0])?.id ?? null
        // Reset activeDocument — see createSite for rationale.
        state.activeDocument = null
        // 0.2 (E2) fix — wipe ONLY when replaying the existing stack against
        // this reload's tree is not provably safe (see `historySafe` above).
        // When safe, leave `_historyPast`/`_historyFuture` untouched — a
        // Mutative draft that isn't assigned to keeps its prior structural
        // sharing, so this is a real "keep", not a copy.
        if (!historySafe) {
          state._historyPast = []
          state._historyFuture = []
        }
        // A reload boundary always ends an in-progress coalescing burst —
        // the next edit must not fold into whatever burst was open before
        // the document was replaced out from under it.
        state._historyCoalesceKey = null
        state.canUndo = state._historyPast.length > 0
        state.canRedo = state._historyFuture.length > 0
        // Always cleared, regardless of `historySafe`: `state.site` above is
        // unconditionally replaced by the freshly-loaded document, so any
        // in-memory edit not already reflected in it is gone either way —
        // preserving the flag without the edit it described would just be a
        // stuck "unsaved" indicator with nothing left to save. Item (b) of
        // this fix (flushing a pending debounced save before a structural
        // reload fires) is what keeps a real edit from reaching this point
        // undelivered in the first place.
        state.hasUnsavedChanges = false
        state._dirtySave = emptyDirtyMarks()
        // Full reload — including a re-parse after a `shifted: true` save,
        // where every `line:col` id below the shifted line changed. There is
        // no pre/post patch set to diff incrementally against (this IS the
        // new baseline), so a full rebuild is not just simplest but correct.
        // `site` (the param, pre-spread) has the same `pages` as `state.site`.
        rebuildNodeIndexes(
          {
            nodeIdToPageIds: state._nodeIdToPageIds,
            textOriginKeyToCount: state._textOriginKeyToCount,
            inlineTailToCount: state._inlineTailToCount,
          },
          site,
        )
        // The site brings the viewports; the project's frame defaults say which
        // one it is shaped for. Either fetch can land second, so both call in —
        // see `projectDefaultViewport.ts`.
        applyProjectDefaultViewport(state)
      })
    },

    clearSite: () => {
      set((state) => {
        state.site = null
        state.packageJson = clonePackageJson(DEFAULT_SITE_PACKAGE_JSON)
        state.siteRuntime = cloneSiteRuntimeConfig(DEFAULT_SITE_RUNTIME)
        state.activePageId = null
        // Reset activeDocument — without a site there can be no active doc.
        state.activeDocument = null
        clearCanvasSelectionDraft(state)
        state._historyPast = []
        state._historyFuture = []
        state._historyCoalesceKey = null
        state.canUndo = false
        state.canRedo = false
        state._dirtySave = emptyDirtyMarks()
        clearNodeIndexes({
          nodeIdToPageIds: state._nodeIdToPageIds,
          textOriginKeyToCount: state._textOriginKeyToCount,
          inlineTailToCount: state._inlineTailToCount,
        })
      })
    },

    updateSiteName: (name) => {
      mutateSite((p) => {
        if (p.name === name) return false
        p.name = name
        return true
      })
    },

    // ── Agent-write live reload (WS-12-adjacent) / Track C5 structural reload ──
    //
    // Deliberately bypasses `mutateSite`/`runHistoricMutation`: these pages
    // were just re-read FROM disk, not edited on the canvas. Recording undo
    // history or flipping `hasUnsavedChanges` here would queue an autosave
    // that writes the content just read straight back out — the exact
    // write -> reload -> re-dirty -> autosave -> write loop this codebase has
    // structurally avoided by having no filesystem watcher (see
    // `fsCodemodAdapter.test.ts`'s header, "write-loop safety"). Untouched
    // pages' own history/dirty state are also left completely alone — this
    // is a targeted patch, not a reload.
    //
    // Track C5 — the ONE exception to "leaves history completely alone":
    // a patched page's node ids can shift (a move/delete/insert always
    // changes the line count under the edit, same as a full `loadSite`
    // reparse would), which can leave `_historyPast`/`_historyFuture`
    // pointing at ids that no longer exist in the freshly-patched tree. Uses
    // the SAME `historySurvivesReload` predicate `loadSite` uses (0.2's
    // fix) — not a second one — computed against the site AFTER the patch,
    // since a stored patch can reference ANY page's node, not just the one(s)
    // being patched. In the common case (the patch doesn't touch any node a
    // stored history entry references — true for essentially every
    // agent-driven `patchPages` call, since those touch pages the user
    // wasn't mid-editing) this is a no-op and history survives exactly as it
    // always has; it only wipes when replaying the stack against the new
    // tree would silently no-op or mint a phantom key, matching `loadSite`'s
    // own reasoning file-for-file (`historyPreservation.ts`).
    patchPages: ({ pages, removedPageIds = [], styleRules, conditions }) => {
      const { site } = get()
      if (!site) return
      if (pages.length === 0 && removedPageIds.length === 0) return

      for (const page of pages) reindexNodeParents(page.nodes)

      const removedIdSet = new Set(removedPageIds)
      const freshById = new Map(pages.map((p) => [p.id, p]))
      const upsertedIds = new Set<string>()
      const actuallyRemovedIds = new Set<string>()
      // A page about to be overwritten that still carried the user's own
      // unsaved edits — surfaced as a toast ("merge: reload only touched
      // pages" policy — the agent's on-disk write wins for a page it also
      // touched).
      const overwrittenDirtyTitles: string[] = []
      const dirty = get()._dirtySave

      const nextPages: Page[] = []
      for (const page of site.pages) {
        if (removedIdSet.has(page.id)) {
          actuallyRemovedIds.add(page.id)
          continue
        }
        const fresh = freshById.get(page.id)
        if (!fresh) {
          nextPages.push(page)
          continue
        }
        freshById.delete(page.id)
        upsertedIds.add(page.id)
        if (dirty.all || dirty.pageIds.has(page.id)) overwrittenDirtyTitles.push(page.title)
        nextPages.push(fresh)
      }
      // Whatever's left in `freshById` didn't match an existing page — a
      // brand-new page (e.g. `studio_create_page`), appended rather than merged.
      for (const fresh of freshById.values()) {
        nextPages.push(fresh)
        upsertedIds.add(fresh.id)
      }

      if (upsertedIds.size === 0 && actuallyRemovedIds.size === 0) return

      // The project-wide registries the same reload recomputed. A re-parsed
      // page's `classIds` name rules from the registry computed WITH it, so
      // carrying the previous one forward resolves those nodes to no class at
      // all (`NodeRenderer`'s `getCanvasNodeClassName`) — the page renders
      // unstyled and collapsed, which is what "the canvas breaks until I
      // refresh" was. Replaced wholesale, not merged: the server's answer is a
      // full recompute from disk, and a merge would resurrect rules the edit
      // deleted. Absent means the caller had nothing fresher — keep what's
      // there rather than blanking a working registry.
      const nextSite: SiteDocument = {
        ...site,
        pages: nextPages,
        ...(styleRules ? { styleRules } : {}),
        ...(conditions ? { conditions } : {}),
      }
      reconcileSiteExplorerInPlace(nextSite)
      // Track C5 — computed against the POST-patch site, pure, before `set()`,
      // same ordering `loadSite` uses. See this method's own doc for why a
      // patch (unlike most of what this method does) has to check this at all.
      const knownNodeIds = collectAllNodeIds(nextSite)

      // Board-frame cleanup for a genuinely removed page — computed against
      // FROZEN (pre-`set()`) state, matching every other board mutation in
      // this codebase (`boardSlice.ts` never runs a pure `Board -> Board`
      // transform against a live draft), then assigned wholesale below.
      let nextBoardsFile = get().boards
      let boardsChanged = false
      if (actuallyRemovedIds.size > 0) {
        const mappedBoards = nextBoardsFile.boards.map((board) => {
          let next = board
          for (const pageId of actuallyRemovedIds) {
            if (!next.frames.some((f) => f.pageId === pageId)) continue
            next = removeFramesForPage(next, pageId)
            boardsChanged = true
          }
          return next
        })
        if (boardsChanged) nextBoardsFile = { ...nextBoardsFile, boards: mappedBoards }
      }

      set((state) => {
        const marks: DirtyMarks = emptyDirtyMarks()
        for (const id of upsertedIds) marks.pageIds.add(id)
        for (const id of actuallyRemovedIds) marks.deletedPageIds.add(id)

        state.site = nextSite
        applyNodeIndexPatch(
          {
            nodeIdToPageIds: state._nodeIdToPageIds,
            textOriginKeyToCount: state._textOriginKeyToCount,
            inlineTailToCount: state._inlineTailToCount,
          },
          site,
          nextSite,
          marks,
        )

        // A page whose local edits were just discarded is no longer
        // meaningfully "unsaved" — drop the stale mark so a later save never
        // tries to persist content the store no longer holds. A genuinely
        // removed page's marks are dropped for the same reason.
        for (const id of upsertedIds) state._dirtySave.pageIds.delete(id)
        for (const id of actuallyRemovedIds) {
          state._dirtySave.pageIds.delete(id)
          state._dirtySave.deletedPageIds.delete(id)
        }

        // Track C5 — wipe ONLY when replaying the existing stack against the
        // freshly-patched tree is not provably safe (see this method's own
        // doc, and `historyPreservation.ts`, whose predicate this reuses
        // verbatim). Safe is the common case and leaves both arrays
        // untouched — a Mutative draft that isn't assigned to keeps its
        // prior structural sharing, same "real keep, not a copy" as `loadSite`.
        const historySafe =
          historySurvivesReload(state._historyPast, knownNodeIds) &&
          historySurvivesReload(state._historyFuture, knownNodeIds)
        if (!historySafe) {
          state._historyPast = []
          state._historyFuture = []
        }
        // A patch that reaches this point changed at least one page or
        // removed one — the same "reload boundary" `loadSite` treats as
        // always ending an open coalescing burst, safe or not.
        state._historyCoalesceKey = null
        state.canUndo = state._historyPast.length > 0
        state.canRedo = state._historyFuture.length > 0

        // Keep the open page/document valid.
        if (state.activePageId && actuallyRemovedIds.has(state.activePageId)) {
          state.activePageId = nextSite.pages[0]?.id ?? null
        }
        if (state.activeDocument?.kind === 'page' && actuallyRemovedIds.has(state.activeDocument.pageId)) {
          state.activeDocument = null
        }

        // A selected/edited node id survives iff it still resolves to at
        // least one page in the freshly-updated index — an insert/delete
        // shifts every `relFile:line:col` id below it (see
        // `server/ai/tools/studio/staleness.ts`'s "shifted" contract), so a
        // shifted id simply won't be a key in the fresh page's node map
        // and drops out of `_nodeIdToPageIds` on its own.
        const survivingSelection = state.selectedNodeIds.filter((id) => state._nodeIdToPageIds.has(id))
        if (survivingSelection.length !== state.selectedNodeIds.length) {
          state.selectedNodeIds = survivingSelection
          state.selectedNodeId = survivingSelection.length > 0 ? survivingSelection[survivingSelection.length - 1]! : null
          if (survivingSelection.length === 0) {
            state.selectedNodeFrameId = null
            state.hoveredNodeId = null
            state.hoveredBreakpointId = null
            state.hoveredFrameId = null
            state.activeClassId = null
          }
        }
        if (state.activeInlineEdit && !state._nodeIdToPageIds.has(state.activeInlineEdit.nodeId)) {
          state.activeInlineEdit = null
        }
        const survivingEntered = state.enteredInstanceIds.filter((id) => state._nodeIdToPageIds.has(id))
        if (survivingEntered.length !== state.enteredInstanceIds.length) {
          state.enteredInstanceIds = survivingEntered
        }

        // A removed page must not leave a ghost board frame or a dangling
        // page-id-keyed frame selection (WS-7.1). A REAL, confirmed removal
        // (this page is genuinely gone from disk) is exactly the case
        // `boardsPendingExplicitRemoval` exists to let through the
        // `boardsSaveGuard.ts` autosave check — see `store-02`'s landmine.
        if (boardsChanged) {
          state.boards = nextBoardsFile
          state.boardsDirty = true
          state.boardsPendingExplicitRemoval = true
        }
        if (actuallyRemovedIds.size > 0 && state.selectedFrameIds.some((id) => actuallyRemovedIds.has(id))) {
          state.selectedFrameIds = state.selectedFrameIds.filter((id) => !actuallyRemovedIds.has(id))
        }
      })

      if (overwrittenDirtyTitles.length > 0) {
        pushToast({
          kind: 'warning',
          title: 'Local edits overwritten',
          body:
            `${overwrittenDirtyTitles.join(', ')} had unsaved canvas edits that were replaced by ` +
            `a change an agent just wrote to the same file${overwrittenDirtyTitles.length === 1 ? '' : 's'}.`,
        })
      }
    },
  }
}
