/**
 * useCanvasNodeArrowKeys — the `node` rung's arrow keys (P2-C, IX-1; the
 * whole selection since P2-C2, OD-16): absolutely positioned layers NUDGE,
 * children of a flex / grid parent REORDER, and any other flow layer NUDGES
 * through `position: relative` (canvas-48). The rules are
 * `canvasNodeArrowMove.ts`; this file is the gesture around them.
 *
 * ## A held key — or a burst of taps — is one undo entry and one source write
 *
 * Auto-repeat fires ~30 keydowns a second, and a person tapping an arrow
 * manages ~25. A store write per keystroke is that many undo entries, commits
 * and `/save` round trips for one gesture (parity 0.3, "undo flooding"; the
 * 2026-10-10 audit measured 15 saves and 7 long tasks for 15 taps). So the
 * unit is a SESSION that outlives a single press:
 *
 *   - nudge: every keydown moves a PREVIEW (the same transient channel an
 *     inspector scrub uses — `setPreviewNodeStyles`, one bag per layer, for a
 *     portal frame; the optimistic style broadcast for a live one). Releasing
 *     the key does NOT write: it arms a {@link NUDGE_SETTLE_MS} settle timer
 *     (the Vector section's burst figure), and the next tap inside the window
 *     RESUMES the same session — no new layout read, no store write. When the
 *     burst settles the session writes ONE `setNodesInlineStylesPerNode` — one
 *     history entry for the whole selection — and flushes the autosave, so the
 *     source is written once, at the end. Anything else that records history
 *     (an inspector edit, ⌘Z, a board change) commits the session FIRST
 *     (`store/pendingGestures.ts`), so the nudge is never overtaken;
 *   - reorder: the first keydown moves the selection one step
 *     (`stepSiblings`: one save batch, one entry — see `@core/page-tree`'s
 *     `planSiblingSteps` for which selections that covers); the repeats of
 *     that hold are claimed and dropped. A structural write per repeat would
 *     queue thirty a second. Press again for the next place.
 *
 * ## A mixed selection
 *
 * Nudging members (absolute ones, and flow children of a non-auto-layout
 * parent) nudge, and flex / grid children stay put — a layout child has no
 * pixel position to move (Penpot's `move-selected` rule). A selection that is
 * all flex / grid children reorders, each along its own parent's axis. A
 * member the flow nudge refuses (sticky, box-less, or one whose promotion to
 * `relative` would shift an absolute descendant) refuses the whole press.
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
import { registerPendingGesture } from '@site/store/pendingGestures'
import { pushToast } from '@ui/components/Toast'
import {
  findReanchoringPromotion,
  measureArrowTargets,
  nudgeStylePatch,
  promotedNodeIds,
  reorderSteps,
  resolveArrowSelectionMove,
  type FlowNudgeRefusal,
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
  /** The key is up: the session is waiting out the settle window (or the layout read) for a next tap. */
  released: boolean
  /** The settle timer that commits a released session. */
  settleTimer: ReturnType<typeof setTimeout> | null
  /** Unregisters the session from `flushPendingGestures`; set while the session has an uncommitted preview. */
  unregisterPending: (() => void) | null
}

/** How long after the last arrow tap a nudge burst is committed — `vectorPaintCommit`'s `BURST_SETTLE_MS`. */
export const NUDGE_SETTLE_MS = 400

const REFUSAL_TITLE = "This layer can't be nudged"
const LOCKED_TITLE = 'Locked layers do not move'
const ACROSS_AXIS_BODY =
  'Its parent lays its children out (flex or grid), so an arrow along that layout reorders it and an arrow across it has nothing to move. Use the arrow along the layout, or set the layer to position: absolute to place it freely.'
const UNMEASURED_BODY = 'It is not rendered in a frame that can report where it sits. Open its screen and select it there.'

/** What the flow nudge says when a layer has no pixel to move (canvas-48) — the reason, and the way out. */
const FLOW_NUDGE_REFUSAL: Record<FlowNudgeRefusal, string> = {
  sticky: "It is position: sticky, so its offsets say where it sticks, not where it sits. Change its position in the inspector to move it.",
  unboxed: 'It is display: contents, so it has no box of its own and an offset would move nothing. Select the element inside it.',
  reanchors:
    'Moving it makes it position: relative, which would shift the absolutely positioned layers inside it. Nudge those, or set its position in the inspector.',
}

/**
 * A component call site draws its component's elements (the selection ring
 * around it shows their box) but is no element itself, so there is nothing at
 * the call site to offset — "no box" would contradict the ring.
 */
const INSTANCE_NUDGE_REFUSAL =
  "It is a component call site: the component decides where its elements sit, so an offset here would move nothing. Double-click to enter it and nudge the element inside, or edit the component."

/** The body of a flow-nudge refusal for the layer it named. */
export function flowNudgeRefusalBody(reason: FlowNudgeRefusal, moduleId: string | undefined): string {
  return reason === 'unboxed' && moduleId === 'studio.instance' ? INSTANCE_NUDGE_REFUSAL : FLOW_NUDGE_REFUSAL[reason]
}

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
  if (session.settleTimer !== null) clearTimeout(session.settleTimer)
  session.settleTimer = null
  session.unregisterPending?.()
  session.unregisterPending = null
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
  const keys = [...plan.horizontal, ...plan.vertical].map((term) => term.property as string).concat(Object.keys(plan.fixed ?? {}))
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
async function resolveSession(
  session: ArrowSession,
  current: () => ArrowSession | null,
  end: () => void,
  settle: (session: ArrowSession) => void,
): Promise<void> {
  const store = useEditorStore.getState()
  const page = selectActiveCanvasPage(store)
  const measured = page ? await measureArrowTargets(page, session.nodeIds, store.activeBreakpointId) : null
  const move = page && measured ? resolveArrowSelectionMove(page, measured, useEditorStore.getState().site?.styleRules) : null

  if (move?.kind === 'reorder') {
    session.state = 'spent'
    const steps = reorderSteps(move.layouts, session)
    if (Object.keys(steps).length > 0) useEditorStore.getState().stepSiblings(session.nodeIds, steps)
    else pushToast({ kind: 'info', title: REFUSAL_TITLE, body: ACROSS_AXIS_BODY })
  } else if (move?.kind === 'refuse') {
    session.state = 'spent'
    pushToast({ kind: 'info', title: REFUSAL_TITLE, body: flowNudgeRefusalBody(move.reason, page?.nodes[move.nodeId]?.moduleId) })
  } else if (move?.kind === 'nudge') {
    // All or nothing: a selection moves together, or not at all.
    const promoted = promotedNodeIds(move.plans)
    const reanchoring = page && promoted.length > 0
      ? await findReanchoringPromotion(page, promoted, store.activeBreakpointId)
      : null
    const refusal = reanchoring
      ? FLOW_NUDGE_REFUSAL.reanchors
      : [...move.plans].map(([nodeId, plan]) => nudgeRefusal(nodeId, plan)).find((reason) => reason !== null)
    if (refusal) {
      session.state = 'spent'
      pushToast({ kind: 'info', title: REFUSAL_TITLE, body: refusal })
    } else {
      session.plans = move.plans
      session.state = 'nudging'
      previewNudge(session)
      if (current() !== session) commitNudge(session)
      else if (session.released) settle(session)
    }
  } else {
    // Nothing was measured: the layer is not rendered in a frame that can say
    // where it sits, so there is nothing to move it from. Say so.
    session.state = 'spent'
    pushToast({ kind: 'info', title: REFUSAL_TITLE, body: UNMEASURED_BODY })
  }
  // A nudging session released during the read is `settle`'s now.
  if (session.released && session.state !== 'nudging' && current() === session) end()
}

/** Registers the scope. Inert while live or read-only. */
export function useCanvasNodeArrowKeys(editable: boolean, isLive: boolean): void {
  // The hold in progress. Read and written only by the scope's handlers,
  // never during render.
  const sessionRef = useRef<ArrowSession | null>(null)

  const end = () => {
    sessionRef.current = null
  }

  /** Commit a nudging session and, if it is still the live one, retire it. */
  const commitSession = (session: ArrowSession) => {
    if (session.state === 'nudging') commitNudge(session)
    if (sessionRef.current === session) end()
  }

  /**
   * Wait out the burst: the session stays live and painted, and registered with
   * the store so any other history write (or ⌘Z) commits it first.
   */
  const settle = (session: ArrowSession) => {
    if (session.unregisterPending === null) {
      session.unregisterPending = registerPendingGesture(() => commitSession(session))
    }
    if (session.settleTimer !== null) clearTimeout(session.settleTimer)
    session.settleTimer = setTimeout(() => commitSession(session), NUDGE_SETTLE_MS)
  }

  const release = () => {
    const session = sessionRef.current
    if (!session) return
    session.released = true
    if (session.state === 'nudging') settle(session)
    // A read still in flight finishes the session itself (`resolveSession`).
    else if (session.state !== 'measuring') end()
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

      // The selection moved on: the old burst is over. A nudge commits now; a
      // layout read still in flight finishes on its own once it lands
      // (`resolveSession` sees it is no longer the live session).
      const previous = sessionRef.current
      if (previous && previous.key !== key) {
        previous.released = true
        commitSession(previous)
        sessionRef.current = null
      }

      const session = sessionRef.current
      if (session) {
        if (session.state === 'spent') return true
        // A tap inside the settle window resumes the burst.
        if (session.settleTimer !== null) clearTimeout(session.settleTimer)
        session.settleTimer = null
        session.released = false
        session.dx += delta.dx
        session.dy += delta.dy
        if (session.state === 'nudging') previewNudge(session)
        return true
      }

      // A locked layer does not move, and neither does a selection holding
      // one — said once per press, never per auto-repeat.
      if (nodeIds.some((id) => page.nodes[id]?.locked === true)) {
        sessionRef.current = {
          nodeIds,
          key,
          dx: 0,
          dy: 0,
          state: 'spent',
          plans: null,
          released: false,
          settleTimer: null,
          unregisterPending: null,
        }
        pushToast({ kind: 'info', title: LOCKED_TITLE, body: 'Unlock it (⌘⇧L) to move the selection.' })
        return true
      }

      const next: ArrowSession = {
        nodeIds,
        key,
        dx: delta.dx,
        dy: delta.dy,
        state: 'measuring',
        plans: null,
        released: false,
        settleTimer: null,
        unregisterPending: null,
      }
      sessionRef.current = next
      void resolveSession(next, () => sessionRef.current, end, settle)
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
