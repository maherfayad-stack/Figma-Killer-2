/**
 * usePrototypeLinkPick — drawing a link WITHOUT dragging the `+` handle.
 *
 * WHY A SECOND ENTRY POINT EXISTS
 * ───────────────────────────────
 * The `+` handle has to be drawn somewhere, so it only exists for a node the
 * canvas can measure. That covers far more than it used to (a
 * `display: contents` component root, a zero-DOM fragment node — see
 * `usePrototypeEndpoints`), but "can this be measured" is the wrong question to
 * gate a FEATURE on: the user has already selected the thing, the selection
 * toolbar is already floating over it, and being told to aim at a 20px dot that
 * is not there is not an answer. So the toolbar carries the same action, and
 * this hook is what it starts.
 *
 * THE GESTURE
 * ───────────
 * A drag commits on pointer-up because the button is held down. A toolbar click
 * leaves the button UP, so this mode commits on the NEXT click instead and
 * cancels on Escape or a click on empty board. Everything else — the rubber
 * band, the snap, the drop wash — is the same draft the drag uses, so the two
 * entry points cannot drift apart.
 *
 * The cross-iframe pointer relay is armed for the whole pick, not just a drag:
 * the frames the user is aiming at are iframes, and without it neither the
 * hover feedback nor the committing click would ever reach this window. See
 * `BoardPrototypeLayer`'s module doc.
 */
import { useContext, useEffect, useRef } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardFrames } from '@site/store/slices/boardSelectors'
import { commitLinkDraft } from '@site/studio/prototypeActions'
import { CanvasViewportActionsContext } from '../CanvasContexts'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from '../canvasPointerRelay'
import { screenToBoard } from '../CanvasRulers/rulerGeometry'
import { frameAtBoardPoint, handlePoint, type BoardPoint, type BoardRect } from './connectorGeometry'
import { frameBoardRect, toBoardRect } from './usePrototypeEndpoints'

/**
 * The relay stamps forwarded events with a pointer id. A pick has no real
 * pointer behind it — nothing is held down — and no listener here reads the id,
 * so it uses the relay's own "unknown pointer" value.
 */
const PICK_POINTER_ID = 0

export function usePrototypeLinkPick(localRects: ReadonlyMap<string, BoardRect>): void {
  const viewportActions = useContext(CanvasViewportActionsContext)
  const frames = useEditorStore(selectActiveBoardFrames)
  const pending = useEditorStore((s) => s.pendingLinkSource)
  const isPicking = useEditorStore((s) => s.linkDraft?.mode === 'pick')

  // One conversion per request. The effect below re-runs whenever the measured
  // rects change (which is often, and by design), and starting a second draft
  // for the same request would reset the rubber band mid-gesture.
  const convertedRef = useRef<string | null>(null)

  const pendingNodeId = pending?.nodeId ?? null
  const local = pendingNodeId ? localRects.get(pendingNodeId) : undefined
  const sourceFrame = pending ? frames.find((frame) => frame.pageId === pending.pageId) : undefined

  useEffect(() => {
    if (!pending) {
      convertedRef.current = null
      return
    }
    const key = `${pending.pageId}::${pending.nodeId}`
    if (convertedRef.current === key) return
    // Not measured yet — the frame may still be mounting. Leave the request
    // standing; the observer's next pass re-runs this.
    if (!local || !sourceFrame) return

    const anchor = handlePoint(toBoardRect(frameBoardRect(sourceFrame), local))
    const store = useEditorStore.getState()
    store.beginLinkDraft({
      sourcePageId: pending.pageId,
      sourceNodeId: pending.nodeId,
      fromX: anchor.x,
      fromY: anchor.y,
      toX: anchor.x,
      toY: anchor.y,
      hoverPageId: null,
      mode: 'pick',
    })
    convertedRef.current = key
    store.clearPendingLinkSource()
  }, [pending, local, sourceFrame])

  useEffect(() => {
    if (!isPicking || !viewportActions) return

    const { canvasRootRef, transformRef } = viewportActions
    const frameRects = frames.map((frame) => ({ ...frameBoardRect(frame), pageId: frame.pageId }))
    const sourcePageId = useEditorStore.getState().linkDraft?.sourcePageId ?? null

    const toBoard = (event: PointerEvent): BoardPoint | null => {
      const root = canvasRootRef.current
      if (!root) return null
      const rect = root.getBoundingClientRect()
      const transform = transformRef.current
      return {
        x: screenToBoard(event.clientX - rect.left, transform.zoom, transform.panX),
        y: screenToBoard(event.clientY - rect.top, transform.zoom, transform.panY),
      }
    }

    const targetAt = (point: BoardPoint): string | null => {
      const hovered = frameAtBoardPoint(frameRects, point)
      // A link from a screen to itself is not a navigation.
      return hovered && hovered.pageId !== sourcePageId ? hovered.pageId : null
    }

    const onMove = (event: PointerEvent) => {
      const point = toBoard(event)
      if (!point) return
      useEditorStore.getState().updateLinkDraft({
        toX: point.x,
        toY: point.y,
        hoverPageId: targetAt(point),
      })
    }

    const onUp = (event: PointerEvent) => {
      const point = toBoard(event)
      const targetPageId = point ? targetAt(point) : null
      if (targetPageId) {
        void commitLinkDraft(targetPageId)
        return
      }
      // Clicked empty board, or back on the source screen: the pick is over
      // and nothing was drawn.
      useEditorStore.getState().cancelLinkDraft()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      useEditorStore.getState().cancelLinkDraft()
    }

    markCanvasPointerRelay(PICK_POINTER_ID)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      clearCanvasPointerRelay()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isPicking, viewportActions, frames])
}
