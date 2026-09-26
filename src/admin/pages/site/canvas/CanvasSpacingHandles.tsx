/**
 * CanvasSpacingHandles — the padding and gap bands drawn on a selected flex
 * or grid container (P5-E, IX-17; Penpot's flex controls).
 *
 * Rendered INSIDE the resize-handle frame (`CanvasResizeHandles`), which the
 * overlay already positions on the selection ring's measured rect every pass
 * — so the bands ride that one measurement and cannot drift off the box, the
 * rule `canvas-17` settled for every piece of selection chrome. Their own
 * geometry is RELATIVE to that frame (`spacingBands`), and is positioned with
 * `--band-*` custom properties the injected in-frame stylesheet reads
 * (`canvasSpacingChromeCss.ts`): CSS Module classes do not exist inside the
 * iframe, and a style object would be the inline styles the rules forbid.
 *
 * The one layout read (`readSpacingGeometry`) runs in a rAF — never in the
 * same pass as a write — when the handles mount, when the node changes in
 * the store (a padding edited in the inspector), and when a
 * `ResizeObserver` sees the container or a child change size. During a drag
 * the bands follow the PREVIEW arithmetically, with no read at all.
 *
 * Shown only for a single selection whose element is a flex or grid
 * container: that is where padding and gap are layout, and where Penpot
 * shows them. Gaps need two children.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { findNodeById } from './InPlaceInspector/findNodeById'
import { isSpacingLayout, spacingBands, type SpacingBand, type SpacingGeometry } from './spacingHandleRules'
import { readSpacingGeometry } from './spacingHandleMeasure'
import { SPACING_BAND_ATTR, useSpacingHandleDrag } from './useSpacingHandleDrag'

interface CanvasSpacingHandlesProps {
  nodeId: string
  iframeDoc: Document
  /** The element the user sees for the node — the one whose padding is edited. */
  target: HTMLElement
}

interface ActiveDrag {
  band: SpacingBand
  patch: Record<string, string>
}

/** The geometry with a drag's previewed values folded in, so the bands follow without a read. */
function previewedGeometry(geometry: SpacingGeometry, patch: Record<string, string> | null): SpacingGeometry {
  if (!patch) return geometry
  const value = (key: string, fallback: number) => (key in patch ? Number.parseFloat(patch[key]!) : fallback)
  return {
    ...geometry,
    padding: {
      top: value('paddingTop', geometry.padding.top),
      right: value('paddingRight', geometry.padding.right),
      bottom: value('paddingBottom', geometry.padding.bottom),
      left: value('paddingLeft', geometry.padding.left),
    },
    rowGap: value('rowGap', geometry.rowGap),
    columnGap: value('columnGap', geometry.columnGap),
  }
}

function bandStyle(band: SpacingBand): CSSProperties {
  return {
    '--band-x': `${band.rect.x}px`,
    '--band-y': `${band.rect.y}px`,
    '--band-width': `${band.rect.width}px`,
    '--band-height': `${band.rect.height}px`,
  } as CSSProperties
}

function bandValueLabel(band: SpacingBand, patch: Record<string, string> | null): string {
  const key =
    band.kind === 'gap'
      ? band.axis === 'column' ? 'columnGap' : 'rowGap'
      : `padding${band.side[0]!.toUpperCase()}${band.side.slice(1)}`
  return String(Math.round(patch && key in patch ? Number.parseFloat(patch[key]!) : band.value))
}

export function CanvasSpacingHandles({ nodeId, iframeDoc, target }: CanvasSpacingHandlesProps) {
  // The node itself: its children say which boxes a gap sits between, and a
  // change to it (an inspector edit, a resync) is a reason to measure again.
  const node = useEditorStore((s) => findNodeById(s, nodeId))
  const [geometry, setGeometry] = useState<SpacingGeometry | null>(null)
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<ActiveDrag | null>(null)
  const childIds = node?.children

  useEffect(() => {
    const view = iframeDoc.defaultView
    if (!view || !childIds) return
    let frame: number | null = null
    const measure = () => {
      frame = null
      const display = view.getComputedStyle(target).display
      setGeometry(isSpacingLayout(display) ? readSpacingGeometry(iframeDoc, target, childIds) : null)
    }
    const schedule = () => {
      frame = frame ?? view.requestAnimationFrame(measure)
    }
    schedule()
    const Observer = (view as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    const observer = Observer ? new Observer(schedule) : null
    observer?.observe(target)
    for (const child of target.children) observer?.observe(child)
    return () => {
      observer?.disconnect()
      if (frame !== null) view.cancelAnimationFrame(frame)
    }
  }, [iframeDoc, target, childIds, node])

  const shown = previewedGeometry(geometry ?? EMPTY_GEOMETRY, drag?.patch ?? null)
  const bands = geometry ? spacingBands(shown) : []

  useSpacingHandleDrag({
    layer,
    iframeDoc,
    nodeId,
    readBands: () => (geometry ? { bands: spacingBands(geometry), geometry } : null),
    onDragChange: setDrag,
  })

  if (!geometry) return null

  return (
    <div ref={setLayer} data-canvas-spacing-layer="true" data-canvas-spacing-dragging={drag ? 'true' : undefined}>
      {bands.map((band, index) => (
        <div
          key={index}
          {...{ [SPACING_BAND_ATTR]: String(index) }}
          data-spacing-kind={band.kind}
          data-spacing-axis={band.kind === 'gap' ? band.axis : band.side === 'top' || band.side === 'bottom' ? 'row' : 'column'}
          data-spacing-active={drag && sameBand(drag.band, band) ? 'true' : undefined}
          style={bandStyle(band)}
        >
          <span data-canvas-spacing-value="true">{bandValueLabel(band, drag && sameBand(drag.band, band) ? drag.patch : null)}</span>
        </div>
      ))}
    </div>
  )
}

function sameBand(a: SpacingBand, b: SpacingBand): boolean {
  if (a.kind === 'padding' && b.kind === 'padding') return a.side === b.side
  if (a.kind === 'gap' && b.kind === 'gap') return a.axis === b.axis && a.rect.x === b.rect.x && a.rect.y === b.rect.y
  return false
}

const EMPTY_GEOMETRY: SpacingGeometry = {
  rect: { x: 0, y: 0, width: 0, height: 0 },
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  border: { top: 0, right: 0, bottom: 0, left: 0 },
  rowGap: 0,
  columnGap: 0,
  children: [],
}
