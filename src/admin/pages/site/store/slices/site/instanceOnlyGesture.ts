/**
 * instanceOnlyGesture — OD-7: a structural gesture (move, delete, duplicate,
 * wrap, group, an insert into it) on markup that lives inside a SHARED
 * component applies to THIS INSTANCE ONLY. The owner's words: "assume it's
 * only this one".
 *
 * `refuseStructuralEdit` refuses those gestures `shared-component`, and it is
 * right to: written into the component's file, the change would land on every
 * instance (48.5% of nodes on the audit corpus, WB-14). Instead of asking, the
 * editor now does the one thing that makes the gesture honest for one
 * instance:
 *
 *   1. **Detach this call site** (`commitStudioDetachForInstance`): the
 *      component's JSX is written in place of `<Card …/>`, bound to the call
 *      site's own values, and the board re-reads it. The markup the user
 *      pointed at is now ordinary markup in this file.
 *   2. **Replay the gesture** against the same elements at their new
 *      addresses (`retry(mapId)`): the canvas tree of the instance and the
 *      tree of the markup that replaced it have the same shape (the parser
 *      inlined the one exactly as the detach wrote the other), so each id is
 *      followed by its child-index path from the instance's root.
 *   3. **Link the two history entries** (`HistoryEntry.linkedToNext`): one ⌘Z
 *      undoes the gesture AND puts `<Card …/>` back; one ⌘⇧Z redoes both.
 *
 * No dialog on the way. When detach itself refuses (a hook, an ambiguous
 * spread — P1-E1's named refusals), the editor makes a COMPONENT COPY for this
 * call site instead (`Card` → `Card2`, `extractInstanceCopy`), marks the copy
 * single-instance (`markSoleInstanceComponentFile`, so the placement rule
 * lets the gesture write into it) and replays there; one ⌘Z undoes the
 * gesture and points the call site back at `Card` (a `swap`). The copy's file
 * stays on disk, unreferenced. Only when the copy refuses too does the user
 * see a refusal — one warning, never the dialog.
 *
 * Ids are followed through what the WRITE reported, never re-guessed from the
 * call site's old position: a detach that adds an import above the call site
 * moves it down a line, and the old "whatever sits at the call site now"
 * lookup then re-issued the gesture against the wrong element. The detach
 * reports the inlined root it created; the copy is found by its own file.
 *
 * **A gesture that crosses the instance's edge is the same recipe (G-3).**
 * Dragging an element out of an instance, or dropping one into its markup,
 * names ids on BOTH sides of the call site. The ones inside follow the detach
 * by child-index path; the ones outside - the page's own container, the
 * sibling an anchor is written against - may have moved too, because the
 * detach adds or removes lines above them (an import, a hoisted hook), so
 * they are re-found by what they ARE (`sourceIdentity.ts`), not by where they
 * used to be. The undo is not the problem it was: the move is journaled
 * (`restore-journal`), so each of the two linked entries puts its files back
 * byte for byte - the move first, then the detach.
 *
 * The user is told once, in one line, with the way back ("Detached Card to
 * place this. Undo restores it."): a detach nobody asked for by name is never
 * silent.
 *
 * Still out of reach, by name: an instance whose component renders SEVERAL
 * root elements has no single container to follow a drop into, so a gesture
 * aimed at the instance itself reports that instead of guessing.
 */
import {
  INLINE_ID_SEPARATOR,
  callSitePosition,
  decodeSourceNodeId,
  isInlinedNodeId,
  markSoleInstanceComponentFile,
  type NodeTree,
  type PageNode,
} from '@core/page-tree'
import { extractInstanceCopy } from '@site/studio/studioSaveRequests'
import { captureIdentities, relocateCapturedIds, waitForBoardRead, type IdentityCapture } from '@site/studio/sourceIdentity'
import { pushToast } from '@ui/components/Toast'
import { commitStudioDetachForInstance } from '@site/studio/studioStructuralCommits'
import { isStructuralCommitInFlight, subscribeStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import type { EditorStore } from '@site/store/types'
import { resolveActiveTreeTarget } from './helpers'
import { detachComponentLabel } from './instanceDetachability'
import type { EditorStoreSetter } from './types'

/** Every id a refused gesture named, re-addressed after the detach — see the module doc. */
export type NodeIdMap = (nodeId: string) => string

/**
 * Take over a gesture refused `shared-component`: detach, replay, link.
 * Returns `false` when this instance cannot be detached for it (the caller
 * shows its refusal as before); `true` when the gesture is on its way —
 * including when the detach is then refused, in which case `onRefused` shows
 * that refusal.
 */
export function applyToThisInstanceOnly(input: {
  get: () => EditorStore
  set: EditorStoreSetter
  /** The node the refusal was about: an element inside the instance. */
  refusedNodeId: string
  /** Re-issue the refused gesture with every id it named passed through `mapId`. */
  retry: (mapId: NodeIdMap) => void
  /** Show the refusal the gesture would have shown without OD-7. */
  onRefused: () => void
  /**
   * The gesture PLACES something (a move, an insert, a transplant) rather than
   * changing what is already there, so the notice says "to place this".
   */
  placing?: boolean
  /**
   * `false` skips the component-copy fallback when the detach refuses. P5-C's
   * `detachInstances` sets it: replaying a DETACH inside a copy of a component
   * whose own detach just refused would ask for another copy, forever.
   */
  componentCopy?: false
}): boolean {
  const { get, set, refusedNodeId, retry, onRefused } = input
  if (!isInlinedNodeId(refusedNodeId)) return false
  const tree = resolveActiveTreeTarget(get())?.tree
  if (!tree) return false
  const callSite = callSitePosition(refusedNodeId)
  const instance = tree.nodes[callSite]
  const [rootId, ...more] = instance?.children ?? []
  if (!instance || rootId === undefined || more.length > 0) return false

  const label = detachComponentLabel(instance)
  // Ids the gesture names outside the instance are followed through the write
  // by identity - captured NOW, while the board still describes the old file.
  const outside = captureOutsideIds(tree, callSite)
  const notice = (how: 'detached' | 'copied'): void =>
    void pushToast({
      kind: 'info',
      title:
        how === 'copied'
          ? `Made ${label} its own copy ${input.placing ? 'to place this' : 'for just this one'}. Undo restores it.`
          : input.placing
            ? `Detached ${label} to place this. Undo restores it.`
            : `Detached ${label} to change just this one. Undo restores it.`,
      location: 'site-editor',
      dedupeKey: `instance-detached:${callSite}`,
    })

  void (async () => {
    const outcome = await commitStudioDetachForInstance({
      callSiteNodeId: callSite,
      label: `Change this ${instance.label ?? label} only`,
    })
    const inlined = outcome?.createdNodeIds[0]
    const detached = resolveActiveTreeTarget(get())?.tree
    if (!outcome) {
      const copied = input.componentCopy === false ? false : await replayInComponentCopy({ get, set, tree, callSite, rootId, retry, outside, notice })
      if (!copied) onRefused()
      return
    }
    if (!inlined || !detached?.nodes[inlined]) {
      pushToast({
        kind: 'info',
        title: 'Instance detached',
        body: 'This instance is now ordinary markup in your file. Make the change again on it.',
        location: 'site-editor',
      })
      return
    }
    const mapInside = followIntoDetached(tree, callSite, rootId, detached, inlined)
    const mapId: NodeIdMap = (nodeId) => (isInsideInstance(nodeId, callSite) ? mapInside(nodeId) : relocateOutside(outside, nodeId))
    const detachAt = get()._historyPast.length - 1
    if (isDetachEntry(get()._historyPast[detachAt])) linkReplay(get, set, detachAt, true)
    notice('detached')
    await replayGesture(retry, mapId)
    await structuralWritesIdle()
    unlinkIfNothingLanded(get, set, detachAt)
  })()
  return true
}

/**
 * Re-issue the gesture. A planner that cannot find an id it was handed throws
 * (`moveNode` on a parent that is not in the tree); inside this fire-and-forget
 * task that would be a silent nothing, with the instance already detached - so
 * it is caught and told, and the undo (which takes the detach back too) is
 * named.
 */
async function replayGesture(retry: (mapId: NodeIdMap) => void, mapId: NodeIdMap): Promise<void> {
  try {
    retry(mapId)
  } catch (err) {
    console.error('[instanceOnlyGesture] the replayed gesture could not run:', err)
    pushToast({
      kind: 'warning',
      title: 'Detached, but the change could not be made',
      body: 'The instance is detached and the change was not applied. Undo restores the instance.',
      location: 'site-editor',
    })
  }
}

/** True for the instance's own call site and everything rendered under it. */
function isInsideInstance(nodeId: string, callSite: string): boolean {
  return nodeId === callSite || nodeId.startsWith(`${callSite}${INLINE_ID_SEPARATOR}`)
}

/**
 * The identity of every source position in `tree` outside the instance - each
 * `~`-separated segment of each id, because a composite id's HEAD (the call
 * site it was reached through) moves with the file just as its tail does.
 */
function captureOutsideIds(tree: NodeTree<PageNode>, callSite: string): IdentityCapture {
  const segments = new Set<string>()
  for (const id of Object.keys(tree.nodes)) {
    if (isInsideInstance(id, callSite) || id.includes('#')) continue
    for (const segment of id.split(INLINE_ID_SEPARATOR)) segments.add(segment)
  }
  return captureIdentities(segments)
}

/** Where an id outside the instance is now: each segment re-found by identity, left alone when that is not certain. */
function relocateOutside(capture: IdentityCapture, nodeId: string): string {
  if (nodeId.includes('#')) return nodeId
  return nodeId
    .split(INLINE_ID_SEPARATOR)
    .map((segment) => relocateCapturedIds(capture, [segment])?.get(segment) ?? segment)
    .join(INLINE_ID_SEPARATOR)
}

/**
 * The fallback: a copy of the component for this call site, the gesture
 * replayed inside it, and an undo that points the call site back. `false`
 * when the copy is refused too.
 */
async function replayInComponentCopy(input: {
  get: () => EditorStore
  set: EditorStoreSetter
  tree: NodeTree<PageNode>
  callSite: string
  rootId: string
  retry: (mapId: NodeIdMap) => void
  outside: IdentityCapture
  notice: (how: 'copied') => void
}): Promise<boolean> {
  const { get, set, tree, callSite, rootId, retry, outside } = input
  const componentRel = decodeSourceNodeId(rootId)?.rel
  const componentName = tree.nodes[rootId]?.fromComponent
  if (!componentRel || !componentName) return false
  const read = waitForBoardRead(8000)
  // Its undo is the swap back below, linked to the replay — not the journal's
  // restore, which would refuse once the replay's own undo left the copy's
  // bytes anything but identical.
  const copy = await extractInstanceCopy(callSite, { undo: 'caller' })
  if (!copy.ok || !copy.newFile) return false
  await read
  const board = resolveActiveTreeTarget(get())?.tree
  const marker = `${INLINE_ID_SEPARATOR}${copy.newFile}:`
  const inCopy = board ? Object.keys(board.nodes).find((id) => id.includes(marker)) : undefined
  if (!board || !inCopy) return false
  const newCallSite = callSitePosition(inCopy)
  markSoleInstanceComponentFile(copy.newFile)
  get().recordStructuralSourceWrite({
    kind: 'push',
    gesture: {
      label: `Change this ${componentName} only`,
      forward: [],
      inverseTemplate: { kind: 'unsupported', message: 'Redo is not available for a change made through a component copy — make the change again.' },
      inverse: [{ kind: 'swap', nodeId: newCallSite, newComponentName: componentName, newComponentSource: 'local', newComponentFile: componentRel }],
    },
  })
  const copyAt = get()._historyPast.length - 1
  linkReplay(get, set, copyAt, true)
  // The copy is the component's file under a new name, line for line, so an
  // inner element keeps its own position; its call-site prefix is the new one.
  const mapId: NodeIdMap = (nodeId) => {
    if (nodeId === callSite) return newCallSite
    if (!nodeId.startsWith(`${callSite}${INLINE_ID_SEPARATOR}`)) return relocateOutside(outside, nodeId)
    const [, inner, ...deeper] = nodeId.split(INLINE_ID_SEPARATOR)
    const location = inner ? decodeSourceNodeId(inner) : null
    const mapped = location
      ? [newCallSite, `${copy.newFile}:${location.line}:${location.col}`, ...deeper].join(INLINE_ID_SEPARATOR)
      : nodeId
    return board.nodes[mapped] ? mapped : nodeId
  }
  input.notice('copied')
  await replayGesture(retry, mapId)
  await structuralWritesIdle()
  unlinkIfNothingLanded(get, set, copyAt)
  return true
}

/**
 * Mark the entry at `at` (the detach, or the component copy) as undone WITH
 * the one above it. Set BEFORE the replay runs, not after it lands: a ⌘Z
 * pressed while the replay is still being written waits for that write and
 * then runs at once — before any code after the write could still link.
 */
function linkReplay(get: () => EditorStore, set: EditorStoreSetter, at: number, linked: boolean): void {
  if (!get()._historyPast[at]) return
  set((state) => {
    const entry = state._historyPast[at]
    if (!entry) return
    if (linked) entry.linkedToNext = true
    else delete entry.linkedToNext
  })
}

/** The replay pushed no entry of its own (refused, or nothing to write): the link has nothing to join. */
function unlinkIfNothingLanded(get: () => EditorStore, set: EditorStoreSetter, at: number): void {
  const past = get()._historyPast
  if (past[at]?.linkedToNext && !past[at + 1]?.structural) linkReplay(get, set, at, false)
}

/** True for the history entry `commitStudioDetachForInstance` pushed. */
function isDetachEntry(entry: EditorStore['_historyPast'][number] | undefined): boolean {
  return entry?.structural?.gesture === 'source' && entry.structural.source.forward[0]?.kind === 'detach'
}

/**
 * Where each element of the instance is in the detached markup: its
 * child-index path from the instance's own root, followed from the element
 * that replaced it. An id outside the instance maps to itself; one whose path
 * no longer exists maps to itself too, and the replayed gesture treats it as
 * the stale id it is (every planner no-ops or refuses on a missing node).
 */
function followIntoDetached(
  before: NodeTree<PageNode>,
  callSite: string,
  rootId: string,
  after: NodeTree<PageNode>,
  inlined: string,
): NodeIdMap {
  return (nodeId) => {
    if (nodeId === callSite || nodeId === rootId) return inlined
    const path: number[] = []
    let current = nodeId
    while (current !== rootId) {
      const parentId = before.nodes[current]?.parentId
      if (!parentId) return nodeId
      const index = before.nodes[parentId]?.children.indexOf(current) ?? -1
      if (index < 0) return nodeId
      path.unshift(index)
      current = parentId
    }
    let found = inlined
    for (const index of path) {
      const next = after.nodes[found]?.children[index]
      if (next === undefined) return nodeId
      found = next
    }
    return found
  }
}

/** Resolves once no structural write is on the wire — the replayed gesture's own write included. */
function structuralWritesIdle(): Promise<void> {
  if (!isStructuralCommitInFlight()) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = subscribeStructuralCommitInFlight(() => {
      if (isStructuralCommitInFlight()) return
      unsubscribe()
      resolve()
    })
  })
}
