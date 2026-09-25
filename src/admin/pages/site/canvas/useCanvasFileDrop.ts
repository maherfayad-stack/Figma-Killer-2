/**
 * useCanvasFileDrop — D2 G15's gesture: an image file dragged in from the
 * operating system and dropped on a board frame.
 *
 * ## One gesture, one write, one toast
 *
 * `planCanvasFileDrop` decides everything that can go wrong before the network
 * is touched, and each of its refusals is one toast with a sentence and no
 * write. A drop that IS good is ONE store action (`runCanvasFileDropPlan`):
 * insert N images as one write, replace an image's source, or set a
 * background — the upload, the optimistic ghost and the write are the
 * store's (`imageDropActions.ts`).
 *
 * ## The answer arrives before release
 *
 * Every `dragover` writes a ref and asks for a rAF; ONE rAF resolves which
 * frame the pointer is over, where in it the image would land, and whether the
 * gesture would be refused — and paints that straight into the DOM
 * (`canvasFileDragPreview.ts` decides, `canvasDragPainter.ts` writes). **Zero
 * React commits per `dragover`**, the same contract S2 gives the element drag,
 * which is why this hook holds no state at all. The verdict painted is the
 * verdict `planCanvasFileDrop` will give on release: both call the same
 * refusal functions.
 *
 * ## Why the listeners are on `window`, not on the canvas root
 *
 * A native `dragover`/`drop` does NOT cross the iframe boundary (the canvas
 * rule every event bridge in this folder exists for), and a frame is exactly
 * where the interesting drops land. `useIframeEventForwarding` re-dispatches
 * the pair on the iframe ELEMENT in the parent document, so a drop over a
 * frame arrives here having bubbled from inside that frame — which only works
 * if the listener is above every frame. `window` is that place, and the plan
 * function's own frame hit-test is what keeps the gesture scoped to the board.
 *
 * ## `dragover` must be cancelled or `drop` never fires
 *
 * A browser's default for a dragover it does not recognise is "no drop here",
 * and `drop` is simply not delivered. Cancelling it is the ONLY way to accept
 * a file — and it is cancelled only for a drag that actually carries files, so
 * an ordinary in-page HTML5 drag (the DOM panel's layer tree still uses
 * `@dnd-kit`) is left entirely alone.
 *
 * ## Why the preview is torn down on THREE events
 *
 * `drop` ends a gesture that landed, `dragleave` one that left the window, and
 * `dragend` one the SOURCE abandoned (Escape, or a drag released outside the
 * browser). Miss any of them and the chip is left painted over the board with
 * no pointer near it — and `dragleave` alone is not enough, because it also
 * fires on every internal boundary crossing.
 */
import { useEffect, useRef } from 'react'
import { pushToast } from '@ui/components/Toast'
import { lookupCanvasPageById, useEditorStore } from '@site/store/store'
import { IMAGE_DROP_TITLE } from '@site/store/slices/site/imageDropActions'
import { measureBoardDropSurfaces } from './canvasDragBoard'
import { paintCanvasDrag } from './canvasDragPainter'
import type { ClientPoint } from './canvasDragSession'
import {
  beginCanvasFileDragSession,
  dropModifiersOf,
  readDraggedFileFacts,
  resolveCanvasFileDragPaint,
  type CanvasFileDragSession,
} from './canvasFileDragPreview'
import {
  NO_DROP_MODIFIERS,
  planCanvasFileDrop,
  type CanvasFileDropModifiers,
  type CanvasFileDropPlan,
  type DroppedFileFacts,
} from './canvasFileDrop'
import { presentFreeMoveRefusal } from './canvasFreeMove'
import { paintCanvasUploadProgress } from './canvasUploadProgress'
import type { CanvasTransform } from './math'

interface UseCanvasFileDropOptions {
  /** Off entirely without structural edit rights — a read-only session writes nothing. */
  enabled: boolean
  /** D1's live canvas transform, for the frame rects the plan hit-tests against. */
  transformRef?: React.RefObject<CanvasTransform>
}

export interface UseCanvasFileDropResult {
  /** Handed to `CanvasFileDropHint`; the preview paints the empty-board chip through it. */
  hintLayerRef: React.RefObject<HTMLDivElement | null>
}

export function useCanvasFileDrop({
  enabled,
  transformRef,
}: UseCanvasFileDropOptions): UseCanvasFileDropResult {
  const hintLayerRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<CanvasFileDragSession | null>(null)
  const pointRef = useRef<ClientPoint>({ x: 0, y: 0 })
  const factsRef = useRef<DroppedFileFacts>({ types: [] })
  const modifiersRef = useRef<CanvasFileDropModifiers>(NO_DROP_MODIFIERS)
  const hintOriginRef = useRef<ClientPoint | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return

    const readPage = (pageId: string) => {
      const site = useEditorStore.getState().site
      return site ? lookupCanvasPageById(site, pageId) : null
    }

    const endPreview = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      const session = sessionRef.current
      sessionRef.current = null
      hintOriginRef.current = null
      if (session?.paintedLayer) paintCanvasDrag(session.paintedLayer, null)
      paintCanvasDrag(hintLayerRef.current, null)
    }

    const runFrame = () => {
      frameRef.current = null
      const session = sessionRef.current
      if (!session) return
      const next = resolveCanvasFileDragPaint(session, {
        point: pointRef.current,
        facts: factsRef.current,
        modifiers: modifiersRef.current,
        transform: transformRef?.current ?? null,
        readPage,
        hintLayer: hintLayerRef.current,
        hintOrigin: hintOriginRef.current,
      })
      // Only one layer ever carries chrome — the frame's or the board's. Clear
      // the one being left BEFORE writing the new one, the same discipline the
      // element drag's `session.paintedLayer` follows for the same reason.
      if (session.paintedLayer && session.paintedLayer !== next.layer) {
        paintCanvasDrag(session.paintedLayer, null)
      }
      session.paintedLayer = next.layer
      paintCanvasDrag(next.layer, next.paint)
    }

    const onDragOver = (event: DragEvent) => {
      const facts = readDraggedFileFacts(event.dataTransfer)
      if (!facts) return
      // Without this the browser refuses the drop outright and `drop` never
      // fires at all — see this module's own doc.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'

      pointRef.current = { x: event.clientX, y: event.clientY }
      factsRef.current = facts
      modifiersRef.current = dropModifiersOf(event)
      if (!sessionRef.current) {
        sessionRef.current = beginCanvasFileDragSession(
          measureBoardDropSurfaces(transformRef?.current ?? null),
        )
        // The hint layer's own client origin, read ONCE per gesture: it is a
        // sibling of the transform layer, so nothing the drag does can move
        // it, and re-reading it per `dragover` would be a forced layout read
        // per pointer event — the exact cost S2 removed from the element drag.
        const rect = hintLayerRef.current?.getBoundingClientRect()
        hintOriginRef.current = rect ? { x: rect.left, y: rect.top } : null
      }
      frameRef.current ??= requestAnimationFrame(runFrame)
    }

    const onDrop = (event: DragEvent) => {
      const transfer = event.dataTransfer
      if (!readDraggedFileFacts(transfer)) return
      event.preventDefault()
      endPreview()

      const plan = planCanvasFileDrop({
        files: Array.from(transfer?.files ?? []),
        point: { x: event.clientX, y: event.clientY },
        modifiers: dropModifiersOf(event),
        transform: transformRef?.current ?? null,
        readPage,
      })
      runCanvasFileDropPlan(plan)
    }

    // `relatedTarget === null` is the drag leaving the WINDOW; every other
    // dragleave is an internal boundary crossing the next dragover re-answers.
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) endPreview()
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragend', endPreview)
    return () => {
      endPreview()
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragend', endPreview)
    }
  }, [enabled, transformRef])

  return { hintLayerRef }
}

/**
 * Carry out a planned drop: a refusal is one toast (or, for a ⌘-drop into a
 * static container, K6's one-click refusal dialog), and an accepted drop is
 * one store action. The upload, the ghost and the write are the store's
 * (`imageDropActions.ts`), so this is the only place a plan is dispatched.
 */
export function runCanvasFileDropPlan(plan: CanvasFileDropPlan): void {
  if (!plan.ok) {
    const { refusal } = plan
    if (refusal.staticParent) {
      presentFreeMoveRefusal({ reason: 'static-parent', ...refusal.staticParent })
      return
    }
    pushToast({
      kind: 'warning',
      title: IMAGE_DROP_TITLE,
      body: refusal.message,
      location: 'site-editor',
      // Dropping the same wrong thing twice is one fact, not two cards.
      dedupeKey: `canvas-file-drop:${refusal.reason}`,
    })
    return
  }

  if (plan.skipped.length > 0) {
    const names = plan.skipped.map((file) => `"${file.name}"`).join(', ')
    pushToast({
      kind: 'warning',
      title: `${plan.skipped.length} file${plan.skipped.length === 1 ? '' : 's'} left out`,
      body: `${names} ${plan.skipped.length === 1 ? 'is not an image' : 'are not images'}, so only the images were added.`,
      location: 'site-editor',
    })
  }

  const store = useEditorStore.getState()
  const { action } = plan
  if (action.kind === 'replace') {
    store.replaceImageInPage(plan.pageId, action.nodeId, plan.files[0]!, paintCanvasUploadProgress)
    return
  }
  if (action.kind === 'background') {
    store.setBackgroundImageInPage(plan.pageId, action.nodeId, plan.files[0]!)
    return
  }
  store.dropImagesIntoPage({
    pageId: plan.pageId,
    parentId: action.target.parentId,
    index: action.target.index,
    files: plan.files,
    maxWidth: action.maxWidth,
    absolute: action.absolute,
    paintProgress: paintCanvasUploadProgress,
  })
}
