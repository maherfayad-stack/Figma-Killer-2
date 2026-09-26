/**
 * useCanvasNodeArrowKeys — the `node` rung's arrow keys (P2-C, IX-1; the
 * whole selection since P2-C2, OD-16): absolutely positioned layers NUDGE,
 * layers laid out by their parent REORDER. The rules are
 * `canvasNodeArrowMove.ts`; this file is the gesture around them.
 *
 * ## A held key is one undo entry and one source write
 *
 * Auto-repeat fires ~30 keydowns a second. A store write per repeat is thirty
 * undo entries and — past the autosave's deferral cap — several source writes
 * for one gesture (parity 0.3, "undo flooding"). So a hold is a SESSION:
 *
 *   - nudge: every keydown moves a PREVIEW (the same transient channel an
 *     inspector scrub uses — `setPreviewNodeStyles`, one bag per layer, for a
 *     portal frame; the optimistic style broadcast for a live one), and the
 *     release writes ONE `setNodesInlineStylesPerNode` — one history entry
 *     for the whole selection — and flushes the autosave straight away, so
 *     the source is written once, at the end;
 *   - reorder: the first keydown moves the selection one step
 *     (`stepSiblings`: one save batch, one entry — see `@core/page-tree`'s
 *     `planSiblingSteps` for which selections that covers); the repeats of
 *     that hold are claimed and dropped. A structural write per repeat would
 *     queue thirty a second. Press again for the next place.
 *
 * ## A mixed selection
 *
 * Positioned members nudge and flow members stay put — a flow child has no
 * pixel position to move (Penpot's `move-selected` rule). A selection that is
 * all flow children reorders, each along its own parent's axis.
 *
 * The release is the dispatcher's keyup BROADCAST (`dispatchEditorKeyUp`):
 * a keyup on the editor document, a keyup inside a portal or bridge frame
 * (`canvasFrameKeyRelay.ts` — P2-B routes frame keyups there, never as a
 * clone), or `null` when focus left the window — a nudge in progress then
 * commits where it was last shown, like a drag whose release was lost.
 *
 * ## The first keydown waits for one layout read
 *
 * Whether a layer is absolute, and which way its parent lays children out, is
 * a computed-style question, and a live frame answers it over `postMessage`
 * (`measureArrowTargets` — one round trip for the whole selection). Keydowns
 * that arrive meanwhile are accumulated, and a release that arrives meanwhile
 * is honoured once the answer lands.
 *
 * ## Guards
 *
 *   - `inline-edit` outranks this rung, so a text edit keeps its caret keys.
 *   - `isTextInputTarget` / `isInsideKeyOwningOverlay`, like every rung.
 *   - Canvas-scoped (`isCanvasKeyboardSurface`), like Tab: with focus in a
 *     panel — the Layers tree, an inspector control — the arrows stay that
 *     panel's. Delete and ⌘D are scoped by intent; arrows are also how a
 *     panel is navigated, so they cannot be.
 *   - A locked layer does not move, and neither does a selection holding one.
 */
import { useRef } from 'react'
import { canWriteInlineStyleForModule, isStylePatchWritableToSource, topLevelSelection } from '@core/page-tree'
import { getKeybindingForCommand, nudgeDelta } from '@admin/spotlight/keybindings'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { flushAutosave } from '@site/hooks/autosaveSchedule'
import { pushToast } from '@ui/components/Toast'
import {
  measureArrowTargets,
  nudgeStylePatch,
  reorderSteps,
  resolveArrowSelectionMove,
  type NudgePlan,
} from './canvasNodeArrowMove'
import { isCanvasKeyboardSurface, isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import {
  broadcastOptimisticStyle,
  broadcastOptimisticStyleClear,
} from './frameAdapter/optimisticStructuralBroadcast'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

interface ArrowSession {
  /** The layers the hold moves: the selection's top level, in selection order. */
  nodeIds: string[]
  /** `nodeIds` joined — a hold continues only while the selection is the same one. */
  key: string
  /** Visual px (or, for a reorder, just a direction) accumulated over the hold. */
  dx: number
  dy: number
  /** `measuring` until the layout read lands; `nudging` while a preview is live; `spent` once there is nothing left to do. */
  state: 'measuring' | 'nudging' | 'spent'
  /** The positioned layers a nudge moves, each with its own offsets. */
  plans: ReadonlyMap<string, NudgePlan> | null
  /** The key was released while the layout read was still in flight. */
  released: boolean
}

const REFUSAL_TITLE = "This layer can't be nudged"
const LOCKED_TITLE = 'Locked layers do not move'

/** Each nudged layer's patch for the hold so far. */
function nudgePatches(session: ArrowSession): { nodeId: string; patch: Record<string, string> }[] {
  if (!session.plans) return []
  return [...session.plans].map(([nodeId, plan]) => ({ nodeId, patch: nudgeStylePatch(plan, session.dx, session.dy) }))
}

function previewNudge(session: ArrowSession): void {
  const patches = nudgePatches(session)
  useEditorStore.getState().setPreviewNodeStyles({
    nodeIds: patches.map(({ nodeId }) => nodeId),
    styles: {},
    stylesByNode: Object.fromEntries(patches.map(({ nodeId, patch }) => [nodeId, patch])),
  })
  for (const { nodeId, patch } of patches) broadcastOptimisticStyle(nodeId, patch)
}

function dropNudgePreview(session: ArrowSession): void {
  const store = useEditorStore.getState()
  if (!session.plans) return
  for (const nodeId of session.plans.keys()) {
    store.clearPreviewNodeStyles(nodeId)
    broadcastOptimisticStyleClear(nodeId)
  }
}

/**
 * The one write a nudge makes: every layer's own patch in ONE transaction
 * (`setNodesInlineStylesPerNode`), so a held arrow over a multi-selection is
 * one undo entry, then one flushed save. The committed values keep showing in
 * a live frame through the same optimistic broadcast the inspector's commit
 * sends, until Vite's update carries them for real.
 */
function commitNudge(session: ArrowSession): void {
  session.state = 'spent'
  const store = useEditorStore.getState()
  const page = selectActiveCanvasPage(store)
  const patches = nudgePatches(session).filter(
    ({ nodeId, patch }) => page?.nodes[nodeId] !== undefined && Object.keys(patch).length > 0,
  )
  if (patches.length === 0) {
    dropNudgePreview(session)
    return
  }
  store.setNodesInlineStylesPerNode(patches)
  store.clearPreviewNodeStyles()
  for (const { nodeId, patch } of patches) broadcastOptimisticStyle(nodeId, patch)
  flushAutosave()
}

/** Why a layer's nudge has no honest target, or `null` when it has one. */
function nudgeRefusal(nodeId: string, plan: NudgePlan): string | null {
  const node = selectActiveCanvasPage(useEditorStore.getState())?.nodes[nodeId]
  if (!node) return null
  if (!canWriteInlineStyleForModule(node.moduleId)) {
    return "Its position is decided inside the component it renders, so it can't be written at this call site."
  }
  const keys = [...plan.horizontal, ...plan.vertical].map((term) => term.property)
  const probe = Object.fromEntries(keys.map((key) => [key, '0px']))
  if (!isStylePatchWritableToSource(node, probe)) {
    return 'Its position is computed in code. Edit the expression in the source instead.'
  }
  return null
}

/**
 * The layout read landed: decide, act, and — if the key already came back up —
 * finish. `current` answers "is this still the live session?", because a new
 * selection may have replaced it while the read was in flight.
 */
async function resolveSession(session: ArrowSession, current: () => ArrowSession | null, end: () => void): Promise<void> {
  const store = useEditorStore.getState()
  const page = selectActiveCanvasPage(store)
  const measured = page ? await measureArrowTargets(page, session.nodeIds, store.activeBreakpointId) : null
  const move = page && measured ? resolveArrowSelectionMove(page, measured, useEditorStore.getState().site?.styleRules) : null

  if (move?.kind === 'reorder') {
    session.state = 'spent'
    const steps = reorderSteps(move.layouts, session)
    if (Object.keys(steps).length > 0) useEditorStore.getState().stepSiblings(session.nodeIds, steps)
  } else if (move?.kind === 'nudge') {
    // All or nothing: a selection moves together, or not at all.
    const refusal = [...move.plans].map(([nodeId, plan]) => nudgeRefusal(nodeId, plan)).find((reason) => reason !== null)
    if (refusal) {
      session.state = 'spent'
      pushToast({ kind: 'info', title: REFUSAL_TITLE, body: refusal })
    } else {
      session.plans = move.plans
      session.state = 'nudging'
      previewNudge(session)
      if (session.released || current() !== session) commitNudge(session)
    }
  } else {
    session.state = 'spent'
  }
  if (session.released && current() === session) end()
}

/** Registers the scope. Inert while live or read-only. */
export function useCanvasNodeArrowKeys(editable: boolean, isLive: boolean): void {
  // The hold in progress. Read and written only by the scope's handlers,
  // never during render.
  const sessionRef = useRef<ArrowSession | null>(null)

  const end = () => {
    sessionRef.current = null
  }

  const release = () => {
    const session = sessionRef.current
    if (!session) return
    session.released = true
    if (session.state === 'nudging') commitNudge(session)
    // A read still in flight finishes the session itself (`resolveSession`).
    if (session.state !== 'measuring') end()
  }

  useEditorKeyScope(
    'node',
    () => !isLive && editable && useEditorStore.getState().selectedNodeId !== null,
    (event) => {
      if (!getKeybindingForCommand('canvas.moveSelection')?.match(event)) return false
      if (isTextInputTarget(event.target)) return false
      if (isInsideKeyOwningOverlay(event.target)) return false
      if (!isCanvasKeyboardSurface(event)) return false
      const delta = nudgeDelta(event)
      if (!delta) return false

      const store = useEditorStore.getState()
      if (!store.selectedNodeId) return false
      // Claimed from here on: the canvas owns the arrows with a layer
      // selected, and letting one through would scroll the frame or the chrome.
      event.preventDefault()
      const page = selectActiveCanvasPage(store)
      if (!page) return true
      const selected = store.selectedNodeIds.length > 0 ? store.selectedNodeIds : [store.selectedNodeId]
      const nodeIds = topLevelSelection(page, selected)
      if (nodeIds.length === 0) return true
      const key = nodeIds.join('\n')

      // The selection moved on mid-hold, or this is a NEW press whose
      // predecessor is still waiting for its layout read: the old hold is
      // over, and it finishes on its own once the read lands.
      const previous = sessionRef.current
      if (previous && (previous.key !== key || previous.released)) {
        release()
        sessionRef.current = null
      }

      const session = sessionRef.current
      if (session) {
        if (session.state === 'spent') return true
        session.dx += delta.dx
        session.dy += delta.dy
        if (session.state === 'nudging') previewNudge(session)
        return true
      }

      // A locked layer does not move, and neither does a selection holding
      // one — said once per press, never per auto-repeat.
      if (nodeIds.some((id) => page.nodes[id]?.locked === true)) {
        sessionRef.current = { nodeIds, key, dx: 0, dy: 0, state: 'spent', plans: null, released: false }
        pushToast({ kind: 'info', title: LOCKED_TITLE, body: 'Unlock it (⌘⇧L) to move the selection.' })
        return true
      }

      const next: ArrowSession = { nodeIds, key, dx: delta.dx, dy: delta.dy, state: 'measuring', plans: null, released: false }
      sessionRef.current = next
      void resolveSession(next, () => sessionRef.current, end)
      return true
    },
    // Only an arrow's release ends the hold — letting go of ⇧ mid-hold must
    // not. `null` is "every key is up" (focus left the window).
    (event) => {
      if (event && !nudgeDelta(event)) return
      release()
    },
  )
}
