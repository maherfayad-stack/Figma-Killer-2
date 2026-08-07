/**
 * RulerGuidesLayer — renders PERSISTED ruler guides (D1), mounted last inside
 * `CanvasTransformLayer` (via `StudioBoardLayers`) so it paints above
 * frames/notes/docs and inherits the canvas pan/zoom transform, exactly like
 * its sibling `BoardGuidesLayer` (transient snap guides — a DIFFERENT
 * concept, see `BoardGuide`'s doc in `@core/studio-board/types.ts` for the
 * name collision this file's name avoids).
 *
 * Interactive, unlike `BoardGuidesLayer`: drag a line to reposition it,
 * double-click to delete it. Pointer math goes through `.canvas`'s own
 * untransformed rect + the LIVE `transformRef` (from
 * `CanvasViewportActionsContext` — see that context's doc for why this reads
 * the ref, not the store's debounced `zoom`/`panX`/`panY`), same as ruler
 * guide CREATION in `CanvasRulers/useRulerGuideCreation.ts`. This is correct
 * regardless of which subtree the pointer event's target DOM node lives in —
 * `screenToBoard` only depends on the client point and `.canvas`'s own box.
 *
 * Mid-drag, the line's board position is written directly to its own ref'd
 * element's `--guide-position` custom property (no `setState` per
 * pointermove — same perf rule `useCanvas`'s gesture handling follows) and
 * committed via `moveGuide` on release.
 */
import { useContext, useRef, type CSSProperties } from 'react'
import type { BoardGuide } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { CanvasViewportActionsContext } from '../CanvasContexts'
import { screenToBoard } from '../CanvasRulers/rulerGeometry'
import { MAX_PAN } from '../math'
import styles from './RulerGuidesLayer.module.css'

/** Guide lines span the full reachable pan range so they always cross the visible viewport regardless of zoom/pan. */
const GUIDE_SPAN_PX = MAX_PAN * 2

function GuideLine({ guide }: { guide: BoardGuide }) {
  const viewportActions = useContext(CanvasViewportActionsContext)
  const moveGuide = useEditorStore((s) => s.moveGuide)
  const removeGuide = useEditorStore((s) => s.removeGuide)
  const lineRef = useRef<HTMLDivElement | null>(null)

  const onPointerDown = (event: React.PointerEvent) => {
    if (!viewportActions) return
    event.preventDefault()
    event.stopPropagation()
    const { canvasRootRef, transformRef } = viewportActions

    const onMove = (e: PointerEvent) => {
      const root = canvasRootRef.current
      const line = lineRef.current
      if (!root || !line) return
      const rect = root.getBoundingClientRect()
      const t = transformRef.current
      const screenPos = guide.axis === 'x' ? e.clientX - rect.left : e.clientY - rect.top
      const pan = guide.axis === 'x' ? t.panX : t.panY
      const boardPos = screenToBoard(screenPos, t.zoom, pan)
      line.style.setProperty('--guide-position', `${boardPos}px`)
    }
    const onUp = (e: PointerEvent) => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      const root = canvasRootRef.current
      if (!root) return
      const rect = root.getBoundingClientRect()
      const t = transformRef.current
      const screenPos = guide.axis === 'x' ? e.clientX - rect.left : e.clientY - rect.top
      const pan = guide.axis === 'x' ? t.panX : t.panY
      moveGuide(guide.id, Math.round(screenToBoard(screenPos, t.zoom, pan)))
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, { once: true })
  }

  return (
    <div
      ref={lineRef}
      className={styles.line}
      data-axis={guide.axis}
      data-testid="ruler-guide-line"
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation()
        removeGuide(guide.id)
      }}
      style={{
        '--guide-position': `${guide.position}px`,
        '--guide-span': `${GUIDE_SPAN_PX}px`,
      } as CSSProperties}
    />
  )
}

/** Stable identity for the no-guides case — an inline `?? []` mints a new array every render. */
const NO_GUIDES: readonly BoardGuide[] = []

export function RulerGuidesLayer() {
  const board = useEditorStore(selectActiveBoard)
  const guides = board?.guides ?? NO_GUIDES

  if (guides.length === 0) return null

  return (
    <div className={styles.layer} data-testid="ruler-guides-layer">
      {guides.map((guide) => (
        <GuideLine key={guide.id} guide={guide} />
      ))}
    </div>
  )
}
