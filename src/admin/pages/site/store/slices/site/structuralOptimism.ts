/**
 * structuralOptimism — instant canvas feedback for the structural SOURCE
 * family (insert / duplicate / wrap / group), which write straight to the
 * user's `.tsx` and — before this — showed NOTHING on the canvas until the
 * write's own resync reparsed the file and replaced the page wholesale.
 * `docs/agent-refs/editor-store.md`'s own words for the old behaviour:
 * "nothing is shown optimistically" — the single biggest latency the user
 * could FEEL in the whole structural-commit chain, because a move or a
 * delete already mutates the tree immediately and only insert/duplicate/wrap
 * did not.
 *
 * ## Why this is safe: a resync always cleans it up, win or partial-win
 *
 * A structural resync (`patchPages`/`loadSite`) replaces the touched PAGE
 * OBJECT wholesale — see `patchPages`'s own doc comment
 * (`nextPages.push(fresh)`). Any preview node this module minted lives only
 * inside that same page's OLD object, so the moment ANY edit in the batch
 * lands (`result.written > 0`), the resync erases every preview node in the
 * touched page(s) as a side effect of replacing the page — whether or not
 * the id this module guessed matches the real `rel:line:col` the codemod
 * produced. Nothing here has to know or predict that id.
 *
 * The one case a resync does NOT happen is a full refusal, or a request that
 * never reached disk at all (`commitStructural`'s own `willReload` gate, and
 * its network-failure `catch`) — `commitStructural` calls `rollback()` on
 * the handle this module hands back in exactly those two cases, and calls
 * `settle()` (stop tracking, touch nothing) on every other outcome.
 *
 * ## What this deliberately is not
 *
 * Not a simulation of the write. It mutates the SAME local `NodeTree` the
 * canvas already renders from, using the exact tree primitives an ordinary
 * CMS-tree gesture would use (`duplicateNodeWithScopedClasses`, `wrapNode`,
 * `wrapNodes`, `insertNode` + `createNode`) — so the preview looks exactly
 * like what an in-memory insert/duplicate/wrap of the SAME module already
 * looks like elsewhere in this editor, not a pixel-exact rendering of the
 * JSX the codemod is about to write. A design-system component's real
 * rendered markup is unknowable without executing the user's code
 * (`CLAUDE.md`'s "parse, never execute"), so this was already true of the
 * ordinary CMS-tree insert path this reuses.
 *
 * ## Invisible to history, dirty-tracking and autosave
 *
 * `previewActiveTreeMutation` (`site/helpers.ts`) applies the recipe's
 * patches directly to `site` and keeps the WS-5.2 node indexes in sync, but
 * deliberately skips `commitHistoryEntry`/`_dirtySave`/`hasUnsavedChanges` —
 * a preview must never become a second, redundant undo step (the gesture's
 * REAL undo entry is the patch-free `source` entry `store-14` pushes once the
 * write lands) and must never make autosave try to persist a node the file
 * does not contain yet.
 *
 * ## The one gap left open, by name
 *
 * A preview id is intentionally NOT `isSourceDerivedNodeId` — it carries no
 * source location, because none exists yet. `insert`/`duplicate`/`wrap`/
 * `group`/`ungroup`/paste/transplant all check
 * `deferWhileStructuralCommitInFlight` BEFORE planning anything, and a
 * preview id is pending only while its own commit is in flight — so any of
 * those gestures fired at a still-pending preview is simply QUEUED, and by
 * the time it actually runs the resync has already replaced the page and the
 * id is gone (an ordinary, already-handled "stale target" no-op, the same
 * precedent `planSourceDuplicateTo` sets for "a stale drop source").
 *
 * `deleteNode(s)` and `moveNode(s)` are different: they mutate the tree
 * IMMEDIATELY and do not go through that queue at all (`store-01`'s
 * optimistic move/delete predates the queue and does not need it — a second
 * move/delete of something already moved/deleted is a no-op). That means a
 * Delete keypress or a drag on the thing you just inserted, fired inside the
 * sub-second window before ITS OWN resync lands, would otherwise run through
 * the "ordinary CMS node" path (`isSourceDerivedNodeId` is false for a
 * preview id) — a real, undo-tracked mutation against a node the resync is
 * about to erase anyway. `isPendingOptimisticNodeId` +
 * `excludePendingOptimisticTargets` close the DELETE half of that (wired into
 * `nodeActions.ts`'s `deleteNode` and `deleteNodesAction.ts`'s `deleteNodes`)
 * by treating a pending id exactly like a missing node. MOVE is left
 * unguarded, by name: closing it would mean threading this module's
 * pending-id set into `@core/page-tree`'s pure `previewStructuralMove`, and
 * the race it would close is narrow: drag the ghost you just made before its
 * own write lands. (A refused move's own tree mutation is taken back since
 * ERR-6 — `structuralCommitRollback.ts`, the same settle-or-roll-back contract
 * as this module's handle.)
 */
import { createNode, insertNode, wrapNode, wrapNodes } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { duplicateNodeWithScopedClasses } from './duplicateWithScopedClasses'
import type { SiteSliceHelpers } from './types'

/** What a preview minted, and how to take it back. */
export interface OptimisticPreviewHandle {
  /** The ids this preview added to the tree — what the pending-id guards check against. */
  readonly nodeIds: readonly string[]
  /**
   * Revert the preview mutation and stop tracking its ids as pending. Call
   * ONLY when `commitStructural` is certain no resync will follow (a full
   * refusal, or the POST never reaching disk) — see this module's own doc.
   */
  rollback: () => void
  /**
   * Stop tracking these ids as pending, without touching the tree. Call once
   * a resync is guaranteed to have replaced (or is about to replace) the
   * page they live on.
   */
  settle: () => void
}

/**
 * `studioStructuralCommits.ts`'s single call into this module once a
 * commit's outcome is known: settle (a resync is about to replace the page
 * anyway) or roll back (nothing landed at all). Guarded like
 * `flushEditorSave` — a failure in this bookkeeping must never stop the
 * toasts/resync around it, so it lives here rather than as a bare method
 * call at each of that module's two call sites.
 */
export function settleOrRollbackOptimistic(
  optimistic: OptimisticPreviewHandle | undefined,
  action: 'settle' | 'rollback',
): void {
  try {
    optimistic?.[action]()
  } catch (err) {
    console.error(`[structuralOptimism] preview ${action} failed:`, err)
  }
}

/**
 * Preview ids currently minted and not yet resolved one way or the other.
 * Module-level, matching `structuralCommitQueue.ts`'s own precedent (the
 * in-flight flag) — both are "is a structural write still on the wire"
 * bookkeeping that several call sites need to read without threading state
 * through every one of them.
 */
const pendingIds = new Set<string>()

export function isPendingOptimisticNodeId(id: string): boolean {
  return pendingIds.has(id)
}

/**
 * Guard for a gesture about to target `nodeIds`: strips any id that is still
 * a pending preview, and toasts once (deduped) when it had to. Returns the
 * ids that are safe to act on — possibly fewer than were asked for, possibly
 * empty when EVERY id was pending.
 */
export function excludePendingOptimisticTargets(nodeIds: readonly string[]): string[] {
  const safe = nodeIds.filter((id) => !pendingIds.has(id))
  if (safe.length < nodeIds.length) {
    pushToast({
      kind: 'warning',
      title: 'Still writing your last change',
      body: 'That element is still being written to your project source — try again in a moment.',
      location: 'site-editor',
      dedupeKey: 'structural-optimistic-pending',
    })
  }
  return safe
}

/**
 * Run a preview builder and swallow any failure into `null` — a broken
 * preview must never block the REAL write, which is the one thing here that
 * actually matters. `console.error`'d, never thrown: this runs synchronously
 * inside a `writeXToSource` call, ahead of the `commitStudioX` it must not
 * prevent.
 */
function safelyBuild(label: string, build: () => (() => void) | null): (() => void) | null {
  try {
    return build()
  } catch (err) {
    console.error(`[structuralOptimism] ${label} preview failed, continuing without one:`, err)
    return null
  }
}

function trackPreview(nodeIds: readonly string[], rollback: () => void): OptimisticPreviewHandle {
  for (const id of nodeIds) pendingIds.add(id)
  let resolved = false
  const resolve = (): void => {
    if (resolved) return
    resolved = true
    for (const id of nodeIds) pendingIds.delete(id)
  }
  return {
    nodeIds,
    rollback: () => {
      const wasResolved = resolved
      resolve()
      if (!wasResolved) rollback()
    },
    settle: resolve,
  }
}

/**
 * W4-1/⌘D — clone `nodeIds` locally, the same way an ordinary CMS-tree
 * duplicate would, so the copies are on screen the instant the gesture fires
 * rather than after the write's own resync. `destination` (K2 Alt-drag) is
 * deliberately NOT previewed here — that gesture already has continuous
 * visual feedback from the drag itself, and ordering a copy against a
 * container's shifting child list is the one duplicate variant this module
 * skips.
 */
export function previewOptimisticDuplicate(
  helpers: SiteSliceHelpers,
  nodeIds: readonly string[],
): OptimisticPreviewHandle | null {
  const madeIds: string[] = []
  const rollback = safelyBuild('duplicate', () =>
    helpers.previewActiveTreeMutation((tree, site) => {
      for (const id of nodeIds) {
        if (!tree.nodes[id] || id === tree.rootNodeId) continue
        const newId = duplicateNodeWithScopedClasses(tree, site, id)
        if (newId) madeIds.push(newId)
      }
      return madeIds.length > 0
    }),
  )
  if (!rollback) return null
  return trackPreview(madeIds, rollback)
}

/**
 * struct-02/W4-1 — mint the new element locally with the module registry's
 * OWN defaults (`props` is the exact merged bag `writeInsertToSource` already
 * computed for the write itself), the same `createNode` an ordinary CMS-tree
 * insert calls. `ghostId` is the SAME id `writeInsertToSource` stamps onto
 * the bridge-frame DOM ghost (`broadcastOptimisticInsert`), so a live (bridge)
 * frame and a portal frame agree on one id for one preview instead of running
 * two disjoint mechanisms.
 */
export function previewOptimisticInsert(
  helpers: SiteSliceHelpers,
  moduleId: string,
  props: Record<string, unknown>,
  parentId: string,
  index: number | undefined,
  ghostId: string,
  /** Same field the plain CMS-tree insert applies post-`createNode` — see `nodeActions.ts`'s `insertNode`. */
  inlineStyles?: Record<string, string>,
): OptimisticPreviewHandle | null {
  const rollback = safelyBuild('insert', () =>
    helpers.previewActiveTreeMutation((tree) => {
      if (!tree.nodes[parentId]) return false
      const node = createNode(moduleId, props)
      node.id = ghostId
      if (inlineStyles && Object.keys(inlineStyles).length > 0) node.inlineStyles = { ...inlineStyles }
      insertNode(tree, node, parentId, index)
      return true
    }),
  )
  if (!rollback) return null
  return trackPreview([ghostId], rollback)
}

/**
 * W4-1 — wrap one element locally, the same `wrapNode` primitive an
 * ordinary CMS-tree wrap calls.
 */
export function previewOptimisticWrap(
  helpers: SiteSliceHelpers,
  nodeId: string,
  containerModuleId: string,
  defaults: Record<string, unknown>,
): OptimisticPreviewHandle | null {
  let wrapperId = ''
  const rollback = safelyBuild('wrap', () =>
    helpers.previewActiveTreeMutation((tree) => {
      if (!tree.nodes[nodeId] || nodeId === tree.rootNodeId) return false
      wrapperId = wrapNode(tree, nodeId, containerModuleId, defaults)
      return true
    }),
  )
  if (!rollback) return null
  return trackPreview([wrapperId], rollback)
}

/**
 * K3/⌘G — wrap a run of siblings in one new container locally, the same
 * `wrapNodes` primitive an ordinary CMS-tree group calls.
 */
export function previewOptimisticGroup(
  helpers: SiteSliceHelpers,
  nodeIds: readonly string[],
  containerModuleId: string,
  defaults: Record<string, unknown>,
): OptimisticPreviewHandle | null {
  let wrapperId = ''
  const rollback = safelyBuild('group', () =>
    helpers.previewActiveTreeMutation((tree) => {
      const existing = nodeIds.filter((id) => tree.nodes[id] && id !== tree.rootNodeId)
      if (existing.length === 0) return false
      wrapperId = wrapNodes(tree, existing, containerModuleId, defaults)
      return true
    }),
  )
  if (!rollback) return null
  return trackPreview([wrapperId], rollback)
}

/** Test seam: drop every tracked id, so one spec's unsettled preview cannot poison the next. */
export function resetOptimisticPreviewTracking(): void {
  pendingIds.clear()
}
