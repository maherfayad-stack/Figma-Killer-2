/**
 * SiteDocument lifecycle actions: createSite, loadSite, clearSite, updateSiteName.
 */

import { findHomePage, reconcileSiteExplorerInPlace, reindexNodeParents } from '@core/page-tree'
import type { Page, SiteDocument } from '@core/page-tree'
import { replaceEqualDeep } from '@core/utils/replaceEqualDeep'
import { removeFramesForPage } from '@core/studio-board'
import { renderCache } from '@site/canvas/renderCache'
import { clearCanvasHover, followCanvasHover, getCanvasHover } from '@site/canvas/canvasHover'
import { clearNodeRenderKeys } from '@site/canvas/nodeRenderKeys'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
} from '@core/site-dependencies/manifest'
import {
  cloneSiteRuntimeConfig,
  DEFAULT_SITE_RUNTIME,
} from '@core/site-runtime'
import { baselineBeforeRead } from '@site/studio/loadedValuesBaseline'
import { clearCanvasSelectionDraft } from '../selectionSlice'
import { createDefaultSiteDocument } from './defaults'
import { emptyDirtyMarks, type DirtyMarks } from './dirtyTracking'
import { reconcileFrameworkClasses } from './framework/reconcile'
import { collectAllNodeIds, historySurvivesReload } from './historyPreservation'
import { retainBoardOnlyEntries } from '../boardHistory'
import { buildReparseNodeIdRemap, remapHistoryEntries } from './historyNodeIdRemap'
import { applyNodeIndexPatch, clearNodeIndexes, nodeIndexesOf, rebuildNodeIndexes } from './nodeIndex'
import { notePagesRead } from './pageReadEpoch'
import { createReparseNodeFollower, publishReparseFollow, type NodeIdFollower } from './reparseNodeFollow'
import { carryRenderKeysThroughReread } from './rereadRenderKeys'
import { rebaseUnsavedEdits, reportLostUnsavedEdits } from './unsavedEditRebase'
import type { SiteSlice, SiteSliceHelpers } from './types'
import type { Draft } from 'mutative'
import type { EditorStore } from '@site/store/types'

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

/** True when the canvas is holding at least one node id a reload could re-address. */
function holdsNodeIds(state: EditorStore): boolean {
  return (
    state.selectedNodeIds.length > 0 ||
    getCanvasHover() !== null ||
    state.activeInlineEdit !== null ||
    state.enteredInstanceIds.length > 0
  )
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** `ids` through `follow`, dropping what did not follow and any duplicate two old ids now share. */
function followIds(ids: readonly string[], follow: NodeIdFollower): string[] {
  const followed: string[] = []
  for (const id of ids) {
    const next = follow(id)
    if (next !== null && !followed.includes(next)) followed.push(next)
  }
  return followed
}

/**
 * ERR-5 — carry every node id the canvas is holding across a reparse, through
 * `follow` (`reparseNodeFollow.ts`): to the element's new address when it has
 * one, dropped when it does not. Never left pointing at whatever inherited the
 * old address. Shared by `loadSite` and `patchPages`, so the two reload paths
 * cannot disagree about where the selection went.
 */
function followCanvasStateThroughReparse(state: Draft<EditorStore>, follow: NodeIdFollower): void {
  const hadSelection = state.selectedNodeIds.length > 0
  const selection = followIds(state.selectedNodeIds, follow)
  if (!sameIds(selection, state.selectedNodeIds)) state.selectedNodeIds = selection
  const anchor = selection.length > 0 ? selection[selection.length - 1]! : null
  if (state.selectedNodeId !== anchor) state.selectedNodeId = anchor
  if (hadSelection && selection.length === 0) {
    state.selectedNodeFrameId = null
    clearCanvasHover()
    state.activeClassId = null
  }

  // The hover lives off the store (`canvasHover.ts`) and follows the same rule.
  followCanvasHover(follow)

  if (state.activeInlineEdit) {
    const edited = follow(state.activeInlineEdit.nodeId)
    if (edited === null) state.activeInlineEdit = null
    else if (edited !== state.activeInlineEdit.nodeId) state.activeInlineEdit.nodeId = edited
  }

  const entered = followIds(state.enteredInstanceIds, follow)
  if (!sameIds(entered, state.enteredInstanceIds)) state.enteredInstanceIds = entered
}

export function createLifecycleActions({
  set,
  get,
  mutateSite,
}: SiteSliceHelpers): LifecycleActions {
  return {
    createSite: (name) => {
      const site = createDefaultSiteDocument(name)
      notePagesRead('all') // ERR-6 — see `pageReadEpoch.ts`
      clearNodeRenderKeys() // PERF-6 — see `canvas/nodeRenderKeys.ts`
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
          nodeIndexesOf(state),
          site,
        )
      })
      return site
    },

    loadSite: (loaded) => {
      // ERR-9 — the user's unsaved edits are carried onto the pages just read
      // rather than discarded with the document they were made in. Only a
      // re-read of the project already open has a baseline to rebase against
      // (`baselineBeforeRead`); a first load or a project switch has none.
      const previous = get().site
      const rebase = rebaseUnsavedEdits(previous?.pages ?? [], loaded.pages, baselineBeforeRead(loaded.pages))
      const site: SiteDocument = rebase.rebasedPageIds.size > 0 ? { ...loaded, pages: rebase.pages } : loaded
      // Clear the render cache BEFORE store hydration so stale HTML from a previous
      // site cannot bleed into the canvas after switching projects.
      // (Guideline #307 / Architect message #1216 — critical integration note)
      renderCache.clear()
      // PERF-6 — a full reload renders every node under its own id again.
      clearNodeRenderKeys()
      // ERR-6 — every page is replaced; an in-flight move/delete must not
      // replay its inverse over what disk just said (`pageReadEpoch.ts`).
      notePagesRead('all')
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
      // `store-08` — a structural write renumbers the `rel:line:col` id of
      // everything below it, so the stack's addresses go stale even though the
      // tree is the same tree. Match the reparse against the document the
      // store still holds and RE-ADDRESS the stack; an empty map (no page
      // matched, or there was no history to re-address) leaves the
      // survivability fallback below to decide exactly as it did before. See
      // `historyNodeIdRemap.ts`.
      //
      // ERR-5 — the same reparse re-addresses what the canvas is HOLDING
      // (selection, hover, inline edit, entered instances, a live drag), so
      // the remap is computed whenever there is anything to re-address, not
      // only when there is history.
      const before = get()
      const hasHistory = before._historyPast.length > 0 || before._historyFuture.length > 0
      const remap =
        (hasHistory || holdsNodeIds(before)) && before.site
          ? buildReparseNodeIdRemap(before.site, site)
          : new Map<string, string>()
      const follow: NodeIdFollower = before.site
        ? createReparseNodeFollower({
            before: before.site,
            after: site,
            pagesOf: before._nodeIdToPageIds,
            touchedPageIds: new Set(site.pages.map((page) => page.id)),
            strictRemap: remap,
            // `activeDocument` is reset below: a Visual Component or layout
            // node id no longer names anything on screen.
            offPageIds: 'drop',
          })
        : () => null
      set((state) => {
        const past = remapHistoryEntries(state._historyPast, remap)
        const future = remapHistoryEntries(state._historyFuture, remap)
        if (past !== state._historyPast) state._historyPast = past
        if (future !== state._historyFuture) state._historyFuture = future
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
          // `store-09` — a `.tsx` reparse says nothing about
          // `.studio/boards.json`, so board-scoped entries survive a site-side
          // wipe. Wiping a sticky-note move because a page's line numbers
          // shifted is the same "one gesture destroys unrelated undo history"
          // bug `store-08` fixed for the site domain.
          state._historyPast = retainBoardOnlyEntries(state._historyPast)
          state._historyFuture = retainBoardOnlyEntries(state._historyFuture)
        }
        // A reload boundary always ends an in-progress coalescing burst —
        // the next edit must not fold into whatever burst was open before
        // the document was replaced out from under it.
        state._historyCoalesceKey = null
        state.canUndo = state._historyPast.length > 0
        state.canRedo = state._historyFuture.length > 0
        // The document is the one just read, so nothing in it is unsaved —
        // except the edits ERR-9's rebase carried onto it, whose pages stay
        // marked for the next save (their values differ from the fresh
        // baseline, which is exactly what that save will send).
        state.hasUnsavedChanges = rebase.rebasedPageIds.size > 0
        state._dirtySave = emptyDirtyMarks()
        for (const pageId of rebase.rebasedPageIds) state._dirtySave.pageIds.add(pageId)
        // Full reload — including a re-parse after a `shifted: true` save,
        // where every `line:col` id below the shifted line changed. There is
        // no pre/post patch set to diff incrementally against (this IS the
        // new baseline), so a full rebuild is not just simplest but correct.
        // `site` (the param, pre-spread) has the same `pages` as `state.site`.
        rebuildNodeIndexes(
          nodeIndexesOf(state),
          site,
        )
        // ERR-5 — `loadSite` used to leave every held id exactly as it was, so
        // a full reload after a write above the selection left it naming
        // whatever inherited the address, or naming nothing at all.
        followCanvasStateThroughReparse(state, follow)
      })
      // ERR-23 — a drag session holds ids outside the store; it follows
      // through the same answer the selection just did.
      publishReparseFollow(follow)
      reportLostUnsavedEdits(rebase.lost)
    },

    clearSite: () => {
      notePagesRead('all')
      clearNodeRenderKeys()
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
        clearNodeIndexes(nodeIndexesOf(state))
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
    patchPages: ({ pages: read, removedPageIds = [], styleRules, conditions }) => {
      const { site } = get()
      if (!site) return
      if (read.length === 0 && removedPageIds.length === 0) return

      // ERR-9 — every unsaved edit on a page this read replaces is carried
      // onto the fresh page (`unsavedEditRebase.ts`), whoever wrote the file:
      // the user's own save or structural commit, an agent, an outside editor.
      // It used to be thrown away with a toast that blamed "an agent".
      const rebase = rebaseUnsavedEdits(site.pages, read, baselineBeforeRead(read))
      const pages = rebase.pages
      for (const page of pages) reindexNodeParents(page.nodes)

      const removedIdSet = new Set(removedPageIds)
      const freshById = new Map(pages.map((p) => [p.id, p]))
      const upsertedIds = new Set<string>()
      const actuallyRemovedIds = new Set<string>()

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
        // PERF-6 — a re-read page is a brand-new object graph even where
        // nothing changed, and every `NodeRenderer` of its frame compares its
        // node by identity. Share every node the read left deep-equal (and the
        // page itself when all of it is), so a write re-renders what it
        // changed and nothing else.
        nextPages.push(replaceEqualDeep(page, fresh))
      }
      // Whatever's left in `freshById` didn't match an existing page — a
      // brand-new page (e.g. `studio_create_page`), appended rather than merged.
      for (const fresh of freshById.values()) {
        nextPages.push(fresh)
        upsertedIds.add(fresh.id)
      }

      if (upsertedIds.size === 0 && actuallyRemovedIds.size === 0) return
      // ERR-6 — a removal shifts every surviving page's position in
      // `site.pages`, which is what an inverse patch addresses it by.
      notePagesRead(actuallyRemovedIds.size > 0 ? 'all' : upsertedIds)
      // PERF-6 — every element a renumbering write moved keeps the React key
      // it rendered under, so it re-renders in place instead of remounting.
      // The alignment it is carried through is the one the canvas-state
      // follower below would otherwise compute again.
      const alignments = carryRenderKeysThroughReread(site.pages, nextPages, upsertedIds, actuallyRemovedIds)

      // The project-wide registries the same reload recomputed. A re-parsed
      // page's `classIds` name rules from the registry computed WITH it, so
      // carrying the previous one forward resolves those nodes to no class at
      // all (`NodeRenderer`'s `getCanvasNodeClassName`) — the page renders
      // unstyled and collapsed, which is what "the canvas breaks until I
      // refresh" was. Replaced wholesale, not merged: the server's answer is a
      // full recompute from disk, and a merge would resurrect rules the edit
      // deleted. Absent means the caller had nothing fresher — keep what's
      // there rather than blanking a working registry.
      //
      // PERF-6 — replaced by VALUE, not by object: every rule the recompute
      // left unchanged keeps its object, and the registry keeps its identity
      // when all of it is unchanged. Every mounted frame's
      // `ClassStyleInjector` regenerates and rewrites its `<style>` on a new
      // registry object, so a fresh-but-equal one restyled every frame for
      // nothing after every write.
      const nextSite: SiteDocument = {
        ...site,
        pages: nextPages,
        ...(styleRules ? { styleRules: replaceEqualDeep(site.styleRules, styleRules) } : {}),
        ...(conditions ? { conditions: replaceEqualDeep(site.conditions, conditions) } : {}),
      }
      reconcileSiteExplorerInPlace(nextSite)
      // Track C5 — computed against the POST-patch site, pure, before `set()`,
      // same ordering `loadSite` uses. See this method's own doc for why a
      // patch (unlike most of what this method does) has to check this at all.
      const knownNodeIds = collectAllNodeIds(nextSite)
      // `store-08` — same re-addressing as `loadSite`: the narrow resync after
      // a structural write re-reads exactly the pages whose ids just shifted.
      // ERR-5 — and the same remap feeds the canvas-state follower below, so
      // it is computed whenever there is history OR a held id.
      const before = get()
      const historyRemap =
        before._historyPast.length > 0 || before._historyFuture.length > 0 || holdsNodeIds(before)
          ? buildReparseNodeIdRemap(site, nextSite)
          : new Map<string, string>()
      const follow = createReparseNodeFollower({
        before: site,
        after: nextSite,
        pagesOf: before._nodeIdToPageIds,
        touchedPageIds: upsertedIds,
        strictRemap: historyRemap,
        // Visual Component and layout trees are not touched by a page patch.
        offPageIds: 'keep',
        alignments,
      })

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
          nodeIndexesOf(state),
          site,
          nextSite,
          marks,
        )

        // A page that is now exactly what disk says holds nothing to save, so
        // its mark goes; a page the rebase carried edits onto keeps one (ERR-9),
        // and the store says so, or the autosave would never write them. A
        // genuinely removed page's marks are dropped too.
        for (const id of upsertedIds) {
          if (rebase.rebasedPageIds.has(id)) state._dirtySave.pageIds.add(id)
          else state._dirtySave.pageIds.delete(id)
        }
        if (rebase.rebasedPageIds.size > 0) state.hasUnsavedChanges = true
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
        const remappedPast = remapHistoryEntries(state._historyPast, historyRemap)
        const remappedFuture = remapHistoryEntries(state._historyFuture, historyRemap)
        if (remappedPast !== state._historyPast) state._historyPast = remappedPast
        if (remappedFuture !== state._historyFuture) state._historyFuture = remappedFuture
        const historySafe =
          historySurvivesReload(state._historyPast, knownNodeIds) &&
          historySurvivesReload(state._historyFuture, knownNodeIds)
        if (!historySafe) {
          // `store-09` — a `.tsx` reparse says nothing about
          // `.studio/boards.json`, so board-scoped entries survive a site-side
          // wipe. Wiping a sticky-note move because a page's line numbers
          // shifted is the same "one gesture destroys unrelated undo history"
          // bug `store-08` fixed for the site domain.
          state._historyPast = retainBoardOnlyEntries(state._historyPast)
          state._historyFuture = retainBoardOnlyEntries(state._historyFuture)
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

        // ERR-5 — every held id follows its ELEMENT, not its address. The old
        // rule ("survives iff it still resolves") was right when a shift
        // vacated an address and silently wrong when it permuted one: an
        // insert above the selection hands its `rel:line:col` to the new
        // element, which still resolves. See `reparseNodeFollow.ts`.
        followCanvasStateThroughReparse(state, follow)

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
      // ERR-23 — a drag session holds ids outside the store; it follows
      // through the same answer the selection just did.
      publishReparseFollow(follow)

      reportLostUnsavedEdits(rebase.lost)
    },
  }
}
