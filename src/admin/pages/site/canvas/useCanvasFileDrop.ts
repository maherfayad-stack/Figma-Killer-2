/**
 * useCanvasFileDrop — D2 G15's gesture: an image file dragged in from the
 * operating system and dropped on a board frame.
 *
 * ## One gesture, one write, one toast
 *
 * `planCanvasFileDrop` decides everything that can go wrong before the network
 * is touched, and each of its refusals is one toast with a sentence and no
 * write. A drop that IS good makes exactly two calls — land the bytes, then
 * one structural commit — and the success toast is the commit's own, so the
 * user never gets two for one gesture.
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
import { getErrorMessage } from '@core/utils/errorMessage'
import { lookupCanvasPageById, useEditorStore } from '@site/store/store'
import { dropStudioAsset } from '@site/studio/dropStudioAsset'
import { measureBoardDropSurfaces } from './canvasDragBoard'
import { paintCanvasDrag } from './canvasDragPainter'
import type { ClientPoint } from './canvasDragSession'
import {
  beginCanvasFileDragSession,
  readDraggedFileFacts,
  resolveCanvasFileDragPaint,
  type CanvasFileDragSession,
} from './canvasFileDragPreview'
import { planCanvasFileDrop } from './canvasFileDrop'
import { findBoardOrigin, isEmptyBoardTarget } from './BoardCanvasLayer/canvasLayerGeometry'
import type { DroppedFileFacts } from './canvasFileDrop'
import type { CanvasTransform } from './math'

/** Title every refusal and every failure of this gesture shares. */
const DROP_TITLE = 'Cannot add that image'

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
  const targetRef = useRef<EventTarget | null>(null)
  const factsRef = useRef<DroppedFileFacts>({ count: 0, type: '' })
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
        transform: transformRef?.current ?? null,
        readPage,
        hintLayer: hintLayerRef.current,
        hintOrigin: hintOriginRef.current,
        freeCanvas: isEmptyBoardTarget(targetRef.current) && findBoardOrigin() !== null,
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
      targetRef.current = event.target
      factsRef.current = facts
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
        transform: transformRef?.current ?? null,
        readPage,
        // P5-G — only a drop on the empty board itself is a free-canvas drop. A
        // drop relayed out of a frame arrives targeted at that frame's iframe,
        // and must never fall through to the canvas even if the frame's drop
        // surface is not registered (a frame mid-mount).
        freeCanvas: isEmptyBoardTarget(event.target) ? findBoardOrigin() : null,
      })

      if (!plan.ok) {
        pushToast({
          kind: 'warning',
          title: DROP_TITLE,
          body: plan.refusal.message,
          location: 'site-editor',
          // Dropping the same wrong thing twice is one fact, not two cards.
          dedupeKey: `canvas-file-drop:${plan.refusal.reason}`,
        })
        return
      }

      if (plan.kind === 'canvas') void landOnCanvas(plan.file, plan.at)
      else void landAndInsert(plan.file, plan.pageId, plan.target.parentId, plan.target.index)
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
 * The two calls a good drop makes. Separate from the listener so the failure
 * of the FIRST one (the upload) is reported with the server's own sentence
 * rather than folded into the structural commit's refusal channel — they fail
 * for genuinely different reasons and only one of them is about the user's
 * source.
 */
async function landAndInsert(file: File, pageId: string, parentId: string, index: number): Promise<void> {
  const src = await landDroppedImage(file)
  if (src === null) return
  useEditorStore.getState().insertImageIntoPage(pageId, parentId, index, { src, alt: altTextFor(file) })
}

/**
 * An image dropped on the empty board: its bytes land exactly as a frame drop's
 * do (the project's `public/`), and it becomes a loose layer centred on the
 * drop point at its intrinsic size (design G2). One structural commit, and the
 * layer appearing is the answer — no toast.
 */
async function landOnCanvas(file: File, at: { x: number; y: number }): Promise<void> {
  const src = await landDroppedImage(file)
  if (src === null) return
  const size = await intrinsicImageSize(file)
  useEditorStore.getState().createCanvasLayer(
    { name: 'img', props: { src, alt: altTextFor(file), ...(size ? { width: size.width, height: size.height } : {}) } },
    size ? { x: at.x - size.width / 2, y: at.y - size.height / 2 } : at,
  )
}

/**
 * Land a dropped file's bytes in the project's `public/` and return the
 * site-root `src` the server derived, or `null` after saying why it failed —
 * the ONE failure sentence both drop destinations (a frame, the free canvas)
 * share, reported apart from the structural commit's refusal channel because
 * it is not about the user's source.
 */
async function landDroppedImage(file: File): Promise<string | null> {
  try {
    return (await dropStudioAsset(file)).src
  } catch (err) {
    console.error('[canvas-file-drop] landing the dropped image failed:', err)
    pushToast({
      kind: 'error',
      title: DROP_TITLE,
      body: getErrorMessage(err, 'The image could not be written into your project.'),
      location: 'site-editor',
    })
    return null
  }
}

/** The image's own pixel size, or `null` when the browser cannot decode it here (the server's sniff decides validity). */
async function intrinsicImageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size.width > 0 && size.height > 0 ? size : null
  } catch {
    // An SVG with no intrinsic size, or a format this browser cannot decode:
    // the layer hugs whatever the image renders at.
    return null
  }
}

/**
 * The `alt` a dropped image starts with: its own file name without the
 * extension. A placeholder the inspector fixes — but an `<img>` with NO `alt`
 * is a real accessibility defect written into someone's repository, and an
 * empty one asserts the image is decorative, which Studio cannot know.
 */
function altTextFor(file: File): string {
  const base = file.name.replace(/\.[^./\\]+$/, '').trim()
  return base.length > 0 ? base : 'Image'
}
