/**
 * RulerGuidesLayer — renders PERSISTED ruler guides (D1), mounted last inside
 * `CanvasTransformLayer` (via `StudioBoardLayers`) so it paints above
 * frames/notes/docs and inherits the canvas pan/zoom transform, exactly like
 * its sibling `BoardGuidesLayer` (transient snap guides — a DIFFERENT
 * concept, see `BoardGuide`'s doc in `@core/studio-board/types.ts` for the
 * name collision this file's name avoids).
 *
 * Interactive, unlike `BoardGuidesLayer`: drag a line to reposition it,
 * double-click to delete it, right-click for a menu (delete this one, clear
 * the axis, clear the board). The menu is what makes deletion discoverable —
 * double-click is the Figma muscle-memory shortcut, not something a line on a
 * canvas advertises. Pointer math goes through `.canvas`'s own
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
import { useContext, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { BoardGuide } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardGuides } from '@site/store/slices/boardSelectors'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { CloseIcon } from 'pixel-art-icons/icons/close'
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
  const clearGuides = useEditorStore((s) => s.clearGuides)
  const lineRef = useRef<HTMLDivElement | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent) => {
    if (!viewportActions) return
    // Only the primary button starts a drag — a right-click has to fall
    // through untouched to `onContextMenu` below, exactly as the board
    // frame's own drag header does (`BoardFramesLayer.tsx`'s module doc).
    if (event.button !== 0) return
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

  const onContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY })
  }

  const axisLabel = guide.axis === 'x' ? 'Vertical' : 'Horizontal'

  return (
    <>
      <div
        ref={lineRef}
        className={styles.line}
        data-axis={guide.axis}
        data-testid="ruler-guide-line"
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        onDoubleClick={(e) => {
          e.stopPropagation()
          removeGuide(guide.id)
        }}
        style={{
          '--guide-position': `${guide.position}px`,
          '--guide-span': `${GUIDE_SPAN_PX}px`,
        } as CSSProperties}
      />
      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel={`${axisLabel} guide at ${guide.position} options`}
          animateExit
          onClose={() => setContextMenu(null)}
        >
          <ContextMenuItem
            danger
            onClick={() => { setContextMenu(null); removeGuide(guide.id) }}
          >
            <span aria-hidden="true"><CloseIcon size={13} /></span>
            Delete guide
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => { setContextMenu(null); clearGuides(guide.axis) }}>
            Clear {guide.axis === 'x' ? 'vertical' : 'horizontal'} guides
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { setContextMenu(null); clearGuides() }}>
            Clear all guides
          </ContextMenuItem>
        </ContextMenu>,
        document.body,
      )}
    </>
  )
}

export function RulerGuidesLayer() {
  // `board.guides` alone (`selectActiveBoardGuides`), not the whole `Board`
  // — a frame/note/doc write changes `Board`'s reference (copy-on-write in
  // `boardsModel.ts`) but reuses this layer's `guides` array untouched. See
  // `boardSlice.ts`'s doc on the four per-collection selectors; that
  // selector already returns a stable empty array with no active board, so
  // there is no separate `?? []` fallback needed here anymore.
  const guides = useEditorStore(selectActiveBoardGuides)

  if (guides.length === 0) return null

  return (
    <div className={styles.layer} data-testid="ruler-guides-layer">
      {guides.map((guide) => (
        <GuideLine key={guide.id} guide={guide} />
      ))}
    </div>
  )
}
