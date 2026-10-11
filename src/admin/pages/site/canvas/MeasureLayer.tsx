/**
 * MeasureLayer — Figma's Alt-hover measurement, in the frame's chrome root
 * (work order K5).
 *
 * With something selected and Alt held, hovering a DIFFERENT node draws the
 * distances between the two boxes (one gap per axis when they're disjoint,
 * two insets per axis when they overlap — see `canvasMeasureGeometry.ts` for
 * the rule) plus the hovered element's padding bands and content box. Every
 * number is a pill in the editor's mono type scale.
 *
 * With NOTHING hovered, the same drawing measures the selection against its
 * parent (P2-E / IX-19, Figma's and Penpot's behaviour) — `resolveMeasureTarget`
 * picks the target, and everything below just measures "the target".
 *
 * ## Where it paints, and why the numbers are not zoom-multiplied
 *
 * It is a child of the frame's chrome root (`FrameChrome.module.css`), so it
 * paints in the frame's own viewport px, beside the iframe — the same space
 * the rings are in, which is why a measurement line starts exactly on the ring
 * it measures from, at every zoom. Lines and pills are counter-scaled to stay
 * one screen pixel / one font size (`--px`, `1 / --canvas-zoom`).
 *
 * The distances themselves are computed in those same frame px, so a pill
 * reads the CSS px a developer would type into a stylesheet — never
 * `px × zoom`.
 *
 * ## Geometry source
 *
 * The rects come from the frame's rect index (`getFrameLocalGeometry`), the
 * same read the rings place from; the only thing it asks the frame for besides
 * is the hovered node's four `padding-*` values (`FrameDocumentAdapter.measure`,
 * the one measurement API a cross-origin bridge frame has), read when the
 * target or the index changes, not on every pass.
 *
 * ## Alt, and the tree ladder
 *
 * `CanvasTreeLadderOverlay` owns the other Alt-hover gesture. The split is
 * `measurementWinsOverTreeLadder` — one predicate, called by both — and its
 * docblock is the rule: measurement while the pointer is over a node outside
 * the selection, the ladder over the selection itself or with nothing
 * selected. Alt is tracked on BOTH the parent document and the frame
 * document because native key events do not cross the iframe boundary, and
 * both stand down while an inline text edit is open.
 */
import { use, useEffect, useEffectEvent, useRef, useState } from 'react'
import { selectCanvasPageFor, useEditorStore } from '@site/store/store'
import { CanvasPageContext, CanvasViewportActionsContext } from './CanvasContexts'
import { isEditableTextTarget } from './canvasEventTargets'
import { unionCanvasOverlayRects, type CanvasOverlayRect } from './canvasOverlayGeometry'
import {
  formatMeasureDistance,
  measureBandMidpoint,
  measureContentBox,
  measurePaddingBands,
  measureRectDistances,
  measureSegmentMidpoint,
  measureSegmentRect,
  parseMeasurePadding,
  resolveMeasureTarget,
  type MeasureSide,
} from './canvasMeasureGeometry'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import { chromeRectOf } from './frameChromeRects'
import { getFrameLocalGeometry } from './frameGeometry/frameGeometryRegistry'
import type { FrameGeometryIndex } from './frameGeometry/frameGeometryIndex'
import styles from './FrameChrome.module.css'

const MEASURE_SIDES: readonly MeasureSide[] = ['left', 'right', 'top', 'bottom']

/** The only computed properties this layer needs; keeps the bridge payload small. */
const MEASURED_PADDING_PROPERTIES = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']

interface MeasurePlacement {
  x: number
  y: number
  width?: number
  height?: number
  /** Pills are centred on their anchor point rather than laid out from its top-left. */
  centered?: boolean
  text?: string
}

/**
 * Last placement written per overlay element, so a pass where nothing moved
 * writes nothing — the same discipline `appliedOverlayPlacements` enforces
 * for rings (same-value style writes are not free across engines).
 */
const appliedMeasureWrites = new WeakMap<HTMLElement, string>()

function writeMeasureElement(element: HTMLElement | null, placement: MeasurePlacement | null): void {
  if (!element) return
  const key = placement ? JSON.stringify(placement) : 'hidden'
  if (appliedMeasureWrites.get(element) === key) return
  appliedMeasureWrites.set(element, key)
  if (!placement) {
    element.style.display = 'none'
    return
  }
  element.style.display = ''
  // A pill is centred on its anchor point at SCREEN size: anchored in frame px,
  // scaled back by the zoom about that point, then centred in its own units.
  element.style.transform = placement.centered
    ? `translate(${placement.x}px, ${placement.y}px) scale(calc(1 / var(--canvas-zoom))) translate(-50%, -50%)`
    : `translate(${placement.x}px, ${placement.y}px)`
  if (placement.width !== undefined) element.style.width = `${placement.width}px`
  if (placement.height !== undefined) element.style.height = `${placement.height}px`
  if (placement.text !== undefined) element.textContent = placement.text
}

interface MeasureLayerProps {
  /** The frame whose index supplies every rect. */
  iframeElement: HTMLIFrameElement | null
  /** This frame's selection, already frame-scoped by the owner. */
  selectedNodeIds: readonly string[]
  /** This frame's hover, already frame/breakpoint-scoped by the owner. */
  hoveredNodeId: string | null
}

export function MeasureLayer({ iframeElement, selectedNodeIds, hoveredNodeId }: MeasureLayerProps) {
  const [altHeld, setAltHeld] = useState(false)
  // Inline text editing owns the keyboard outright — measuring mid-edit would
  // paint chrome over the caret for a gesture the user is not making.
  const inlineEditing = useEditorStore((s) => s.activeInlineEdit !== null)
  const framePageId = use(CanvasPageContext)
  const framePage = useEditorStore((s) => selectCanvasPageFor(s, framePageId))
  const viewportActions = use(CanvasViewportActionsContext)
  const elementsRef = useRef<Map<string, HTMLElement> | null>(null)
  if (elementsRef.current === null) elementsRef.current = new Map()
  // The hovered node's padding, read from the frame once per (target, index).
  const paddingRef = useRef<{ nodeId: string; index: FrameGeometryIndex; padding: Record<string, string> } | null>(null)
  // Bumped whenever the loop tears down, so an in-flight pass that resolves
  // after unmount never writes to detached elements.
  const passTokenRef = useRef(0)
  const measureInFlightRef = useRef(false)

  // IX-19 — whether a node has been hovered in this frame since Alt went down.
  // Once one has, the tree ladder is anchored on it and the no-hover parent
  // fallback stands down (`resolveMeasureTarget`). Derived from props during
  // render (React's "adjust state when a prop changes" pattern), reset with Alt.
  const [hoverSeenDuringHold, setHoverSeenDuringHold] = useState(false)
  const hoverSeenNow = altHeld && hoveredNodeId !== null
  if (hoverSeenNow && !hoverSeenDuringHold) setHoverSeenDuringHold(true)
  if (!altHeld && hoverSeenDuringHold) setHoverSeenDuringHold(false)

  const measureTargetId =
    altHeld && !inlineEditing
      ? resolveMeasureTarget({
          selectedNodeIds,
          hoveredNodeId,
          hoverSeenDuringHold: hoverSeenDuringHold || hoverSeenNow,
          parentOf: (nodeId) => framePage?.nodes[nodeId]?.parentId ?? null,
        })
      : null
  const active = measureTargetId !== null

  // Alt on BOTH documents: a keydown inside the frame never reaches the parent
  // (native events don't cross the boundary) and vice versa. `blur` clears,
  // because an Alt-Tab away releases the key somewhere we can't hear it.
  useEffect(() => {
    const clear = () => setAltHeld(false)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTextTarget(event.target)) return
      if (event.key === 'Alt' || event.altKey) setAltHeld(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt' || !event.altKey) setAltHeld(false)
    }

    const cleanups: Array<() => void> = []
    const attach = (doc: Document) => {
      doc.addEventListener('keydown', handleKeyDown)
      doc.addEventListener('keyup', handleKeyUp)
      doc.defaultView?.addEventListener('blur', clear)
      cleanups.push(() => {
        doc.removeEventListener('keydown', handleKeyDown)
        doc.removeEventListener('keyup', handleKeyUp)
        doc.defaultView?.removeEventListener('blur', clear)
      })
    }

    attach(document)

    // The frame document only exists in portal mode, and only once its
    // adapter has registered — poll one rAF at a time, exactly as the tree
    // ladder does. A bridge frame has no local document to listen on; its
    // Alt arrives with the forwarded pointer events instead.
    let frame = 0
    let frameDocAttached = false
    const attachFrameDocument = () => {
      if (frameDocAttached) return
      const doc = resolvePortalDocument(iframeElement)
      if (!doc) {
        if (iframeElement) frame = requestAnimationFrame(attachFrameDocument)
        return
      }
      frameDocAttached = true
      attach(doc)
    }
    attachFrameDocument()
    iframeElement?.addEventListener('load', attachFrameDocument)

    return () => {
      cancelAnimationFrame(frame)
      iframeElement?.removeEventListener('load', attachFrameDocument)
      for (const cleanup of cleanups) cleanup()
    }
  }, [iframeElement])

  const drawPass = useEffectEvent((
    index: FrameGeometryIndex,
    padding: Record<string, string>,
    hovered: string,
  ) => {
    // `hovered` is the measure TARGET: the hovered node, or (IX-19) the
    // selection's parent when nothing is hovered.
    const elements = elementsRef.current!
    const get = (key: string) => elements.get(key) ?? null
    const hideAll = () => {
      for (const element of elements.values()) writeMeasureElement(element, null)
    }

    // ── READ phase: arithmetic over the index; nothing is touched ──────────
    let selectionRect: CanvasOverlayRect | null = null
    for (const id of selectedNodeIds) {
      const rect = chromeRectOf(index, framePage, id)
      if (rect) selectionRect = unionCanvasOverlayRects(selectionRect, rect)
    }
    const hoveredRect = chromeRectOf(index, framePage, hovered)
    if (!selectionRect || !hoveredRect) {
      hideAll()
      return
    }

    // One screen pixel, in frame px, for the lines.
    const zoom = viewportActions?.transformRef?.current?.zoom ?? 1
    const segments = measureRectDistances(selectionRect, hoveredRect)
    const parsedPadding = parseMeasurePadding(padding)
    const bands = measurePaddingBands(hoveredRect, parsedPadding)
    const contentBox = measureContentBox(hoveredRect, parsedPadding)

    // ── WRITE phase ───────────────────────────────────────────────────────
    const painted = new Set<string>()
    const paint = (key: string, placement: MeasurePlacement) => {
      painted.add(key)
      writeMeasureElement(get(key), placement)
    }

    for (const band of bands) {
      paint(`padding-${band.side}`, { x: band.rect.x, y: band.rect.y, width: band.rect.width, height: band.rect.height })
      const mid = measureBandMidpoint(band)
      paint(`padding-label-${band.side}`, { x: mid.x, y: mid.y, centered: true, text: formatMeasureDistance(band.value) })
    }
    if (bands.length > 0) {
      paint('content-box', { x: contentBox.x, y: contentBox.y, width: contentBox.width, height: contentBox.height })
    }

    for (const segment of segments) {
      const rect = measureSegmentRect(segment, 1 / zoom)
      paint(`line-${segment.side}`, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      const mid = measureSegmentMidpoint(segment)
      paint(`line-label-${segment.side}`, { x: mid.x, y: mid.y, centered: true, text: formatMeasureDistance(segment.distance) })
    }

    for (const [key, element] of elements) {
      if (!painted.has(key)) writeMeasureElement(element, null)
    }
  })

  const runPass = useEffectEvent(async (token: number) => {
    const iframe = iframeElement
    const hovered = measureTargetId
    if (!iframe || !hovered || selectedNodeIds.length === 0) return
    // One outstanding pass at a time: a BRIDGE frame's index read is a real
    // postMessage round trip, and issuing one per rAF regardless would queue
    // requests faster than the frame can answer them.
    if (measureInFlightRef.current) return
    measureInFlightRef.current = true
    const pass = async (): Promise<void> => {
      const index = await getFrameLocalGeometry(iframe)
      if (!index || token !== passTokenRef.current) return
      let cached = paddingRef.current
      if (!cached || cached.nodeId !== hovered || cached.index !== index) {
        const adapter = listFrameAdapters().get(iframe) ?? null
        const measured = adapter ? (await adapter.measure([{ nodeId: hovered }], MEASURED_PADDING_PROPERTIES))[0] : undefined
        if (token !== passTokenRef.current) return
        cached = { nodeId: hovered, index, padding: measured?.computedStyle ?? {} }
        paddingRef.current = cached
      }
      drawPass(index, cached.padding, hovered)
    }
    // A frame that navigated mid-read rejects; the next rAF retries.
    await pass().catch(() => undefined)
    measureInFlightRef.current = false
  })

  useEffect(() => {
    if (!active) return
    const token = passTokenRef.current + 1
    passTokenRef.current = token

    let frame = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      void runPass(token)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      // Invalidates any promise still in flight — see `passTokenRef`.
      passTokenRef.current += 1
      paddingRef.current = null
    }
  }, [active, iframeElement])

  if (!active) return null

  return (
    <>
      {MEASURE_SIDES.map((side) => (
        <div
          key={`padding-${side}`}
          ref={(element) => {
            if (element) elementsRef.current?.set(`padding-${side}`, element)
            else elementsRef.current?.delete(`padding-${side}`)
          }}
          className={styles.measurePadding}
          data-canvas-measure-padding="true"
          data-side={side}
        />
      ))}
      <div
        ref={(element) => {
          if (element) elementsRef.current?.set('content-box', element)
          else elementsRef.current?.delete('content-box')
        }}
        className={styles.measureContentBox}
        data-canvas-measure-content-box="true"
      />
      {MEASURE_SIDES.map((side) => (
        <div
          key={`line-${side}`}
          ref={(element) => {
            if (element) elementsRef.current?.set(`line-${side}`, element)
            else elementsRef.current?.delete(`line-${side}`)
          }}
          className={styles.measureLine}
          data-canvas-measure-line="true"
          data-side={side}
        />
      ))}
      {MEASURE_SIDES.map((side) => (
        <div
          key={`line-label-${side}`}
          ref={(element) => {
            if (element) elementsRef.current?.set(`line-label-${side}`, element)
            else elementsRef.current?.delete(`line-label-${side}`)
          }}
          className={styles.measureLabel}
          data-canvas-measure-label="true"
          data-measure-kind="distance"
          data-side={side}
        />
      ))}
      {MEASURE_SIDES.map((side) => (
        <div
          key={`padding-label-${side}`}
          ref={(element) => {
            if (element) elementsRef.current?.set(`padding-label-${side}`, element)
            else elementsRef.current?.delete(`padding-label-${side}`)
          }}
          className={styles.measureLabel}
          data-canvas-measure-label="true"
          data-measure-kind="padding"
          data-side={side}
        />
      ))}
    </>
  )
}
