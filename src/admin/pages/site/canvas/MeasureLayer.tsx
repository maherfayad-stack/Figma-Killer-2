/**
 * MeasureLayer — Figma's Alt-hover measurement, in the in-frame overlay
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
 * Same two-space split as the selection rings (`BreakpointSelectionOverlay`'s
 * docblock): when the design-mode overlay root exists, everything portals
 * INTO the frame's own `<body>` and is positioned in the frame's own
 * coordinates, so pan/zoom moves it as one composited transform and there is
 * no per-frame conversion to go stale. When it doesn't — a live/bridge frame,
 * or the startup window before the injector's effect has run — the chrome
 * falls back to the parent canvas root and each rect is projected once,
 * through `CanvasOverlayMeasureSession.project`, the SAME arithmetic the ring
 * fallback uses.
 *
 * The distances themselves are always computed in FRAME coordinates and
 * projected only for painting, so a pill reads the CSS px a developer would
 * type into a stylesheet — never `px × zoom`.
 *
 * ## Geometry source
 *
 * `FrameDocumentAdapter.measure` — one call per pass, both nodes at once,
 * with the four `padding-*` properties. That is the only measurement API a
 * cross-origin bridge frame has, so routing through it is what makes this
 * work outside portal mode at all.
 *
 * ONE exception, and it is deliberate: in portal mode the RECTS come from
 * `measureIframeLocalRect` instead of the adapter's. The adapter returns
 * body-relative rects; the in-frame rings are positioned from
 * iframe-viewport-relative ones, and the two differ by whatever margin the
 * user's `body` carries. A measurement line that starts a few px away from
 * the selection ring it is measuring FROM reads as broken, so the layer
 * follows the ring. In bridge mode there is no local element to read and no
 * in-frame ring to disagree with, so the adapter's rect is used directly.
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
import { createPortal } from 'react-dom'
import { selectCanvasPageFor, useEditorStore } from '@site/store/store'
import { cn } from '@ui/cn'
import { CanvasPageContext } from './CanvasContexts'
import { isEditableTextTarget } from './canvasEventTargets'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import {
  createCanvasOverlayMeasureSession,
  measureIframeLocalRect,
  unionCanvasOverlayRects,
  type CanvasOverlayRect,
} from './canvasOverlayGeometry'
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
  type MeasureRect,
  type MeasureSide,
} from './canvasMeasureGeometry'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import type { NodeMeasurement } from './frameAdapter/FrameDocumentAdapter'
import styles from './MeasureLayer.module.css'

const MEASURE_SIDES: readonly MeasureSide[] = ['left', 'right', 'top', 'bottom']

/** The only computed properties this layer needs; keeps the bridge payload small. */
const MEASURED_PADDING_PROPERTIES = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']

/** Segment thickness in FRAME px — the same 1px the selection ring uses, so both scale together. */
const SEGMENT_THICKNESS = 1

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
  element.style.transform = placement.centered
    ? `translate(${placement.x}px, ${placement.y}px) translate(-50%, -50%)`
    : `translate(${placement.x}px, ${placement.y}px)`
  if (placement.width !== undefined) element.style.width = `${placement.width}px`
  if (placement.height !== undefined) element.style.height = `${placement.height}px`
  if (placement.text !== undefined) element.textContent = placement.text
}

interface MeasureLayerProps {
  /** The frame whose adapter supplies every measurement. */
  iframeElement: HTMLIFrameElement | null
  /** In-iframe overlay root (design mode), or `null` for a live/bridge frame. */
  overlayRoot: HTMLElement | null
  /** Parent-document fallback target — the canvas root, or `null` while it resolves. */
  portalTarget: HTMLElement | null
  /** `'scoped'` (inside the canvas root) or `'fixed'` (body fallback), for the fallback CSS. */
  portalMode: 'scoped' | 'fixed'
  /** Canvas root, for the fallback projection's origin. */
  canvasRoot: HTMLElement | null
  /** This frame's selection, already frame-scoped by the owner. */
  selectedNodeIds: readonly string[]
  /** This frame's hover, already frame/breakpoint-scoped by the owner. */
  hoveredNodeId: string | null
  /** Whether the caller shows canvas chrome at all (permissions). */
  enabled: boolean
}

export function MeasureLayer({
  iframeElement,
  overlayRoot,
  portalTarget,
  portalMode,
  canvasRoot,
  selectedNodeIds,
  hoveredNodeId,
  enabled,
}: MeasureLayerProps) {
  const [altHeld, setAltHeld] = useState(false)
  // Inline text editing owns the keyboard outright — measuring mid-edit would
  // paint chrome over the caret for a gesture the user is not making.
  const inlineEditing = useEditorStore((s) => s.activeInlineEdit !== null)
  const framePageId = use(CanvasPageContext)
  const framePage = useEditorStore((s) => selectCanvasPageFor(s, framePageId))
  const elementsRef = useRef<Map<string, HTMLElement> | null>(null)
  if (elementsRef.current === null) elementsRef.current = new Map()
  const nodeElementCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (nodeElementCacheRef.current === null) nodeElementCacheRef.current = new CanvasNodeElementCache()
  // Bumped whenever the loop tears down, so an in-flight `measure` promise
  // that resolves after unmount never writes to detached elements.
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
    enabled && altHeld && !inlineEditing
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
    // No chrome, no gesture: a frame the caller does not draw rings in (a pure
    // Viewer) must not keep two key listeners per document alive either.
    if (!enabled) return
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
  }, [enabled, iframeElement])

  const drawPass = useEffectEvent((
    measurements: readonly NodeMeasurement[],
    hovered: string,
    iframe: HTMLIFrameElement,
  ) => {
    // `hovered` is the measure TARGET: the hovered node, or (IX-19) the
    // selection's parent when nothing is hovered.
    const elements = elementsRef.current!
    const get = (key: string) => elements.get(key) ?? null
    const hideAll = () => {
      for (const element of elements.values()) writeMeasureElement(element, null)
    }

    // ── READ phase ────────────────────────────────────────────────────────
    // In-frame rects when the overlay lives in the frame (must agree with the
    // ring to the pixel — see the module doc); the adapter's wire rects
    // otherwise, projected once below.
    const frameDoc = overlayRoot ? resolvePortalDocument(iframe) : null
    const byId = new Map(measurements.map((entry) => [entry.nodeId, entry]))
    const cache = nodeElementCacheRef.current!
    const rectFor = (nodeId: string): CanvasOverlayRect | null => {
      if (frameDoc) return measureIframeLocalRect(cache.resolve(frameDoc, nodeId, framePage))
      const wire = byId.get(nodeId)?.rect ?? null
      return wire ? { x: wire.x, y: wire.y, width: wire.width, height: wire.height } : null
    }

    let selectionRect: CanvasOverlayRect | null = null
    for (const id of selectedNodeIds) {
      const rect = rectFor(id)
      if (rect) selectionRect = unionCanvasOverlayRects(selectionRect, rect)
    }
    const hoveredRect = rectFor(hovered)
    cache.retainOnly(new Set([...selectedNodeIds, hovered]))
    if (!selectionRect || !hoveredRect) {
      hideAll()
      return
    }

    const segments = measureRectDistances(selectionRect, hoveredRect)
    const padding = parseMeasurePadding(byId.get(hovered)?.computedStyle ?? {})
    const bands = measurePaddingBands(hoveredRect, padding)
    const contentBox = measureContentBox(hoveredRect, padding)
    // The one parent-document read of the pass, taken before any write.
    const session = frameDoc ? null : createCanvasOverlayMeasureSession(iframe, canvasRoot)
    const project = (rect: MeasureRect): MeasureRect => (session ? session.project(rect) : rect)

    // ── WRITE phase ───────────────────────────────────────────────────────
    const painted = new Set<string>()
    const paint = (key: string, placement: MeasurePlacement) => {
      painted.add(key)
      writeMeasureElement(get(key), placement)
    }

    for (const band of bands) {
      const rect = project(band.rect)
      paint(`padding-${band.side}`, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      const mid = measureBandMidpoint(band)
      const point = project({ x: mid.x, y: mid.y, width: 0, height: 0 })
      paint(`padding-label-${band.side}`, {
        x: point.x,
        y: point.y,
        centered: true,
        text: formatMeasureDistance(band.value),
      })
    }
    if (bands.length > 0) {
      const rect = project(contentBox)
      paint('content-box', { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }

    for (const segment of segments) {
      const rect = project(measureSegmentRect(segment, SEGMENT_THICKNESS))
      paint(`line-${segment.side}`, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
      const mid = measureSegmentMidpoint(segment)
      const point = project({ x: mid.x, y: mid.y, width: 0, height: 0 })
      paint(`line-label-${segment.side}`, {
        x: point.x,
        y: point.y,
        centered: true,
        text: formatMeasureDistance(segment.distance),
      })
    }

    for (const [key, element] of elements) {
      if (!painted.has(key)) writeMeasureElement(element, null)
    }
  })

  const runPass = useEffectEvent((token: number) => {
    const iframe = iframeElement
    const hovered = measureTargetId
    if (!iframe || !hovered || selectedNodeIds.length === 0) return
    const adapter = listFrameAdapters().get(iframe) ?? null
    if (!adapter) return
    // One outstanding `measure` at a time. Portal mode resolves in a
    // microtask, but a BRIDGE frame's measure is a real postMessage round
    // trip — issuing one per rAF regardless would queue requests faster than
    // the frame can answer them.
    if (measureInFlightRef.current) return
    measureInFlightRef.current = true

    const ids = [...new Set([...selectedNodeIds, hovered])]
    void adapter
      .measure(ids.map((nodeId) => ({ nodeId })), MEASURED_PADDING_PROPERTIES)
      .then((measurements) => {
        if (token !== passTokenRef.current) return
        drawPass(measurements, hovered, iframe)
      })
      // A frame that navigated mid-measure rejects; the next rAF retries.
      .catch(() => undefined)
      .finally(() => {
        measureInFlightRef.current = false
      })
  })

  useEffect(() => {
    if (!active) return
    const token = passTokenRef.current + 1
    passTokenRef.current = token

    let frame = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      runPass(token)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      // Invalidates any promise still in flight — see `passTokenRef`.
      passTokenRef.current += 1
    }
  }, [active, iframeElement, overlayRoot])

  const target = overlayRoot ?? portalTarget
  if (!active || !target) return null

  // In-frame: appearance comes from the injected stylesheet via the stable
  // `data-canvas-measure-*` selectors (CSS Module class names do not exist
  // inside the frame). Parent-document fallback: the module's own classes.
  const inFrame = Boolean(overlayRoot)
  const fallbackClass = (name: string) => (inFrame ? undefined : styles[name])
  const fallbackMode = inFrame ? undefined : portalMode
  return createPortal(
    <>
      {MEASURE_SIDES.map((side) => (
        <div
          key={`padding-${side}`}
          ref={(element) => {
            if (element) elementsRef.current?.set(`padding-${side}`, element)
            else elementsRef.current?.delete(`padding-${side}`)
          }}
          className={fallbackClass('paddingBand')}
          data-canvas-measure-mode={fallbackMode}
          data-canvas-measure-padding="true"
          data-side={side}
        />
      ))}
      <div
        ref={(element) => {
          if (element) elementsRef.current?.set('content-box', element)
          else elementsRef.current?.delete('content-box')
        }}
        className={fallbackClass('contentBox')}
        data-canvas-measure-mode={fallbackMode}
        data-canvas-measure-content-box="true"
      />
      {MEASURE_SIDES.map((side) => (
        <div
          key={`line-${side}`}
          ref={(element) => {
            if (element) elementsRef.current?.set(`line-${side}`, element)
            else elementsRef.current?.delete(`line-${side}`)
          }}
          className={fallbackClass('line')}
          data-canvas-measure-mode={fallbackMode}
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
          className={cn(fallbackClass('label'), fallbackClass('distanceLabel'))}
          data-canvas-measure-mode={fallbackMode}
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
          className={cn(fallbackClass('label'), fallbackClass('paddingLabel'))}
          data-canvas-measure-mode={fallbackMode}
          data-canvas-measure-label="true"
          data-measure-kind="padding"
          data-side={side}
        />
      ))}
    </>,
    target,
  )
}
