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
 * store's (`imageDropActions.ts`). Released over the EMPTY board of a Studio
 * board, the images become loose layers on the free canvas instead (P5-G,
 * `landOnCanvas`).
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
import { getErrorMessage } from '@core/utils/errorMessage'
import { IMAGE_DROP_TITLE, altTextFor, reportUnlanded } from '@site/store/slices/site/imageDropActions'
import { requirePublicAsset, type PublicStudioAsset } from '@site/studio/dropStudioAsset'
import { landImageSource } from '@site/studio/landImageSource'
import { imageSourceName, type LandableImageSource } from '@site/store/slices/site/imageDropShapes'
import { readDroppedImageIntake } from './canvasDropIntake'
import { svgToJsxNode } from '@site/studio/svgToJsxNode'
import { INLINE_SVG_MAX_CHARS, insertSvgAtTarget } from './canvasSvgInsert'
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
import { findBoardOrigin, isEmptyBoardTarget } from './BoardCanvasLayer/canvasLayerGeometry'
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
  const targetRef = useRef<EventTarget | null>(null)
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
      // Files first, then one image link (IMG-5) — `canvasDropIntake.ts`.
      const intake = readDroppedImageIntake(event.dataTransfer)
      if (!intake) return
      event.preventDefault()
      endPreview()

      const plan = planCanvasFileDrop({
        intake,
        point: { x: event.clientX, y: event.clientY },
        modifiers: dropModifiersOf(event),
        transform: transformRef?.current ?? null,
        readPage,
        // P5-G — only a drop on the empty board itself is a free-canvas drop. A
        // drop relayed out of a frame arrives targeted at that frame's iframe,
        // and must never fall through to the canvas even if the frame's drop
        // surface is not registered (a frame mid-mount).
        freeCanvas: isEmptyBoardTarget(event.target) ? findBoardOrigin() : null,
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
 * (`imageDropActions.ts`, and `landOnCanvas` below for the free canvas), so
 * this is the only place a plan is dispatched.
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

  if (plan.kind === 'canvas') {
    if (plan.inlineSvg) void placeSvgsOnCanvas(fileSources(plan.sources), plan.at)
    else void landOnCanvas(plan.sources, plan.at)
    return
  }

  const store = useEditorStore.getState()
  const { action } = plan
  if (action.kind === 'replace') {
    store.replaceImageInPage(plan.pageId, action.nodeId, plan.sources[0]!, paintCanvasUploadProgress)
    return
  }
  if (action.kind === 'background') {
    store.setBackgroundImageInPage(plan.pageId, action.nodeId, plan.sources[0]!)
    return
  }
  // P5-D SVG-5 — `.svg` files are written as inline `<svg>` JSX, one insert
  // each at the drop line (the paste's own write); ⌥ keeps them `<img>`s.
  if (plan.inlineSvg) {
    fileSources(plan.sources).forEach((file, offset) => {
      const target = { ok: true as const, pageId: plan.pageId, parentId: action.target.parentId, index: action.target.index + offset }
      void insertSvgAtTarget({ kind: 'file', file }, target, { undoLabel: 'Add SVG', refusalTitle: IMAGE_DROP_TITLE })
    })
    return
  }
  store.dropImagesIntoPage({
    pageId: plan.pageId,
    parentId: action.target.parentId,
    index: action.target.index,
    sources: plan.sources,
    maxWidth: action.maxWidth,
    absolute: action.absolute,
    paintProgress: paintCanvasUploadProgress,
  })
}

/**
 * P5-D SVG-5 — `.svg` files dropped on the empty board: each becomes a loose
 * layer whose root IS the inline `<svg>` (converted and sanitised exactly as
 * a frame drop's), placed at the drop point with the same cascade. One too
 * large to inline lands as an image layer instead; any other refusal is a
 * toast naming it.
 */
async function placeSvgsOnCanvas(files: readonly File[], at: { x: number; y: number }): Promise<void> {
  const asImages: File[] = []
  for (const [index, file] of files.entries()) {
    const markup = file.size > INLINE_SVG_MAX_CHARS ? null : await file.text().catch(() => null)
    const converted = markup === null ? null : svgToJsxNode(markup)
    if (!converted || (!converted.ok && converted.reason === 'too-large')) {
      asImages.push(file)
      continue
    }
    if (!converted.ok) {
      pushToast({ kind: 'warning', title: IMAGE_DROP_TITLE, body: converted.message, location: 'site-editor' })
      continue
    }
    const offset = index * CANVAS_DROP_CASCADE
    useEditorStore.getState().createCanvasLayer(converted.node, { x: at.x + offset, y: at.y + offset })
  }
  if (asImages.length > 0) await landOnCanvas(asImages.map((file) => ({ kind: 'file', file })), at)
}

/** The files of an inline-SVG plan — `inlineSvg` is only ever set when every source is a file. */
function fileSources(sources: readonly LandableImageSource[]): File[] {
  return sources.flatMap((source) => (source.kind === 'file' ? [source.file] : []))
}

/** How far each further image of a multi-file free-canvas drop steps from the one before, in board units (IMG-9's cascade). */
const CANVAS_DROP_CASCADE = 24

/**
 * Images dropped on the empty board (P5-G): each one's bytes land exactly as a
 * frame drop's do (the project's `public/`, through `asset-drop`), and each
 * becomes its own loose layer at its intrinsic size — the size the landing
 * route read from the header bytes — the first centred on the drop point and
 * every further one cascaded down-right. One structural commit per layer, in
 * drop order; the layers appearing is the answer, so a landing that succeeds
 * raises no toast. Files that fail to land are reported in ONE toast through
 * the frame drop's own `reportUnlanded` (a warning when some landed, an error
 * only when none did), and the rest still land.
 */
async function landOnCanvas(sources: readonly LandableImageSource[], at: { x: number; y: number }): Promise<void> {
  const failures: { name: string; message: string }[] = []
  let landedCount = 0
  for (const [index, source] of sources.entries()) {
    let landed: PublicStudioAsset
    try {
      // No `pageRel`: a loose layer is Studio's own file, so the image is
      // always a `public/` literal, never an import into `.studio/`.
      landed = requirePublicAsset(await landImageSource(source))
    } catch (err) {
      console.error('[canvas-file-drop] landing a dropped image on the free canvas failed:', err)
      failures.push({ name: imageSourceName(source), message: getErrorMessage(err, 'The image could not be saved to your project.') })
      continue
    }
    const size = landed.width !== null && landed.height !== null && landed.width > 0 && landed.height > 0
      ? { width: landed.width, height: landed.height }
      : null
    landedCount += 1
    const offset = index * CANVAS_DROP_CASCADE
    const centre = { x: at.x + offset, y: at.y + offset }
    useEditorStore.getState().createCanvasLayer(
      { name: 'img', props: { src: landed.src, alt: altTextFor(source), ...(size ? { width: size.width, height: size.height } : {}) } },
      size ? { x: centre.x - size.width / 2, y: centre.y - size.height / 2 } : centre,
    )
  }
  reportUnlanded(failures, landedCount)
}
