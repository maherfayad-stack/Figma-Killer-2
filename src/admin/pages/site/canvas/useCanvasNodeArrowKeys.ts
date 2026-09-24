/**
 * useCanvasNodeArrowKeys — the `node` rung's arrow keys (P2-C, IX-1): the
 * selected layer NUDGES if it is absolutely positioned and REORDERS if it is
 * laid out by its parent. The rules are `canvasNodeArrowMove.ts`; this file is
 * the gesture around them.
 *
 * ## A held key is one undo entry and one source write
 *
 * Auto-repeat fires ~30 keydowns a second. A store write per repeat is thirty
 * undo entries and — past the autosave's deferral cap — several source writes
 * for one gesture (parity 0.3, "undo flooding"). So a hold is a SESSION:
 *
 *   - nudge: every keydown moves a PREVIEW (the same transient channel an
 *     inspector scrub uses — `setPreviewNodeStyles` for a portal frame, the
 *     optimistic style broadcast for a live one), and the release writes ONE
 *     `setNodeInlineStyles` — one history entry — and flushes the autosave
 *     straight away, so the source is written once, at the end;
 *   - reorder: the first keydown moves the layer one place (`moveNode`, a
 *     structural write through the commit queue); the repeats of that hold are
 *     claimed and dropped. A structural write per repeat would queue thirty a
 *     second, each its own undo step. Press again for the next place.
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
 * (`measureArrowTarget`). Keydowns that arrive meanwhile are accumulated, and
 * a release that arrives meanwhile is honoured once the answer lands.
 *
 * ## Guards
 *
 *   - `inline-edit` outranks this rung, so a text edit keeps its caret keys.
 *   - `isTextInputTarget` / `isInsideKeyOwningOverlay`, like every rung.
 *   - Canvas-scoped (`isCanvasKeyboardSurface`), like Tab: with focus in a
 *     panel — the Layers tree, an inspector control — the arrows stay that
 *     panel's. Delete and ⌘D are scoped by intent; arrows are also how a
 *     panel is navigated, so they cannot be.
 *   - One selected layer. A multi-selection claims the key and does nothing
 *     (multi-select move is P5-F), as ⌥↑ / ⌥↓ already do.
 */
import { useRef } from 'react'
import { canWriteInlineStyleForModule, isStylePatchWritableToSource } from '@core/page-tree'
import { getKeybindingForCommand, nudgeDelta } from '@admin/spotlight/keybindings'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { flushAutosave } from '@site/hooks/autosaveSchedule'
import { pushToast } from '@ui/components/Toast'
import {
  authoredOffsets,
  measureArrowTarget,
  moveNodeAmongSiblings,
  nudgeStylePatch,
  reorderStep,
  resolveArrowMove,
  type NudgePlan,
} from './canvasNodeArrowMove'
import { isCanvasKeyboardSurface, isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import {
  broadcastOptimisticStyle,
  broadcastOptimisticStyleClear,
} from './frameAdapter/optimisticStructuralBroadcast'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

interface ArrowSession {
  nodeId: string
  /** Visual px (or, for a reorder, just a direction) accumulated over the hold. */
  dx: number
  dy: number
  /** `measuring` until the layout read lands; `nudging` while a preview is live; `spent` once there is nothing left to do. */
  state: 'measuring' | 'nudging' | 'spent'
  plan: NudgePlan | null
  /** The key was released while the layout read was still in flight. */
  released: boolean
}

const REFUSAL_TITLE = "This layer can't be nudged"

function previewNudge(session: ArrowSession): void {
  if (!session.plan) return
  const patch = nudgeStylePatch(session.plan, session.dx, session.dy)
  useEditorStore.getState().setPreviewNodeStyles({ nodeIds: [session.nodeId], styles: patch })
  broadcastOptimisticStyle(session.nodeId, patch)
}

function dropNudgePreview(nodeId: string): void {
  useEditorStore.getState().clearPreviewNodeStyles(nodeId)
  broadcastOptimisticStyleClear(nodeId)
}

/**
 * The one write a nudge makes. The committed value keeps showing in a live
 * frame through the same optimistic broadcast the inspector's commit sends,
 * until Vite's update carries it for real.
 */
function commitNudge(session: ArrowSession): void {
  session.state = 'spent'
  const plan = session.plan
  if (!plan) return
  const patch = nudgeStylePatch(plan, session.dx, session.dy)
  const store = useEditorStore.getState()
  const node = selectActiveCanvasPage(store)?.nodes[session.nodeId]
  if (!node || Object.keys(patch).length === 0) {
    dropNudgePreview(session.nodeId)
    return
  }
  store.setNodeInlineStyles(session.nodeId, patch)
  store.clearPreviewNodeStyles(session.nodeId)
  broadcastOptimisticStyle(session.nodeId, patch)
  flushAutosave()
}

/** Why a nudge has no honest target, or `null` when it has one. */
function nudgeRefusal(nodeId: string, patchKeys: readonly string[]): string | null {
  const node = selectActiveCanvasPage(useEditorStore.getState())?.nodes[nodeId]
  if (!node) return null
  if (!canWriteInlineStyleForModule(node.moduleId)) {
    return "Its position is decided inside the component it renders, so it can't be written at this call site."
  }
  const probe = Object.fromEntries(patchKeys.map((key) => [key, '0px']))
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
  const node = page?.nodes[session.nodeId]
  const measured = page && node ? await measureArrowTarget(page, session.nodeId, store.activeBreakpointId) : null
  const move = measured && node
    ? resolveArrowMove(measured, authoredOffsets(node, useEditorStore.getState().site?.styleRules ?? {}))
    : null

  if (move?.kind === 'reorder') {
    session.state = 'spent'
    const step = reorderStep(move.layout, session)
    if (step !== null) moveNodeAmongSiblings(session.nodeId, step)
  } else if (move?.kind === 'nudge') {
    const refusal = nudgeRefusal(session.nodeId, [
      ...move.plan.horizontal.map((term) => term.property),
      ...move.plan.vertical.map((term) => term.property),
    ])
    if (refusal) {
      session.state = 'spent'
      pushToast({ kind: 'info', title: REFUSAL_TITLE, body: refusal })
    } else {
      session.plan = move.plan
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
      const nodeId = store.selectedNodeId
      if (!nodeId) return false
      // Claimed from here on: the canvas owns the arrows with a layer
      // selected, and letting one through would scroll the frame or the chrome.
      event.preventDefault()
      if (store.selectedNodeIds.length > 1) return true
      const page = selectActiveCanvasPage(store)
      const node = page?.nodes[nodeId]
      if (!page || !node || nodeId === page.rootNodeId || node.locked) return true

      // The selection moved on mid-hold, or this is a NEW press whose
      // predecessor is still waiting for its layout read: the old hold is
      // over, and it finishes on its own once the read lands.
      const previous = sessionRef.current
      if (previous && (previous.nodeId !== nodeId || previous.released)) {
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

      const next: ArrowSession = { nodeId, dx: delta.dx, dy: delta.dy, state: 'measuring', plan: null, released: false }
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

