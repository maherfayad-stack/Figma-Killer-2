import type { RefObject } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardFrames, selectHasActiveBoard } from '@site/store/slices/boardSelectors'
import { guideAxisForRuler, resolveRulerOriginBoard } from './rulerGeometry'
import { RulerH } from './RulerH'
import { RulerV } from './RulerV'
import { useRulerGuideCreation } from './useRulerGuideCreation'
import styles from './CanvasRulers.module.css'

interface CanvasRulersProps {
  /** `.canvas` itself — both rulers' on-screen length AND the coordinate origin every measurement here is relative to. */
  canvasRootRef: RefObject<HTMLElement | null>
  transformRef: RefObject<CanvasTransform>
}

/**
 * CanvasRulers — the top/left rulers + corner square. Mounts as a SIBLING of
 * `CanvasTransformLayer`, inside `.canvas` (`CanvasRoot.tsx`) — see this
 * folder's `rulerGeometry.ts` for the 80px-offset landmine this mount point
 * exists to respect. Design mode only; `CanvasRoot` doesn't mount this in
 * live mode (a live frame has no pan/zoom to rule against).
 *
 * Guide creation (drag out from a ruler) is gated on an active Studio board
 * — `BoardGuide` only exists on `Board` (see its doc in `@core/studio-board`),
 * so there is nowhere to persist a guide outside board mode. The rulers
 * themselves still render everywhere design mode does.
 *
 * **Which ruler makes which guide.** Each ruler produces a guide PARALLEL to
 * itself, dragged perpendicular to itself — the Figma/Sketch/Illustrator
 * convention, and the only one that matches the gesture: you pull a horizontal
 * line DOWN out of the top ruler, and a vertical line RIGHT out of the left
 * one. So the top (horizontal) ruler creates an `axis: 'y'` guide — a
 * horizontal line positioned by board Y — and the left (vertical) ruler
 * creates an `axis: 'x'` guide. See `BoardGuide` for what `axis` names.
 *
 * Note this is DELIBERATELY not the same axis each ruler PAINTS: the top ruler
 * measures the x axis (its ticks are x positions, `useRulerCanvasPaint({ axis:
 * 'x' })`) while creating y guides. The two axes answer different questions —
 * "what do my ticks count" versus "which way does my guide lie" — and an
 * earlier version conflated them, which made every guide come out
 * perpendicular to the ruler it was dragged from.
 */
export function CanvasRulers({ canvasRootRef, transformRef }: CanvasRulersProps) {
  // `board.frames` + a cheap boolean, not the whole `Board` — this only
  // needs the frame list (for `resolveRulerOriginBoard`'s "zero on the lone
  // frame" rule) and whether a board is active at all (to gate guide
  // creation), so a note/doc/guide write elsewhere on the board must not
  // re-render the rulers. See `boardSlice.ts`'s doc on the per-collection
  // selectors.
  const hasActiveBoard = useEditorStore(selectHasActiveBoard)
  const frames = useEditorStore(selectActiveBoardFrames)
  const addGuide = useEditorStore((s) => s.addGuide)
  const origin = resolveRulerOriginBoard(hasActiveBoard ? { frames } : null)

  const onCreate = hasActiveBoard ? (axis: 'x' | 'y', position: number) => addGuide(axis, position) : null

  // Destructured IMMEDIATELY at the call site — same pattern
  // `useCanvas()`'s own `transformRef` consumer (`CanvasRoot.tsx`) uses.
  // Holding the whole hook-call result (`const hCreation = useRulerGuideCreation(...)`)
  // and reading `hCreation.previewElRef` / `hCreation.onPointerDown` via member
  // expressions later in JSX is what `react-hooks/refs` flags — once ANY
  // field of a hook's returned object is a ref, the compiler conservatively
  // treats every later property access on that binding as a potential
  // `.current` read "during render." Destructuring right here, into plain
  // locals, is the recognized safe shape for consuming a hook that returns a
  // ref alongside other values.
  // Each ruler makes a guide parallel to itself — `guideAxisForRuler` owns
  // that mapping (and its test), because the correct pairing reads backwards
  // at a glance and was wired inverted once. See the module doc.
  const { previewElRef: hPreviewElRef, onPointerDown: hOnPointerDown } = useRulerGuideCreation({
    axis: guideAxisForRuler('horizontal'),
    canvasRootRef,
    transformRef,
    onCreate,
  })
  const { previewElRef: vPreviewElRef, onPointerDown: vOnPointerDown } = useRulerGuideCreation({
    axis: guideAxisForRuler('vertical'),
    canvasRootRef,
    transformRef,
    onCreate,
  })

  return (
    <div className={styles.shell} data-testid="canvas-rulers">
      <div className={styles.corner} />
      <RulerH
        lengthSourceRef={canvasRootRef}
        transformRef={transformRef}
        originBoardX={origin.x}
        onPointerDown={hOnPointerDown}
      />
      <RulerV
        lengthSourceRef={canvasRootRef}
        transformRef={transformRef}
        originBoardY={origin.y}
        onPointerDown={vOnPointerDown}
      />
      {/* Always mounted, hidden by default (`display: none` in the module
          CSS) — `useRulerGuideCreation` toggles visibility/position
          imperatively via `previewElRef`, never through React state. */}
      <div ref={hPreviewElRef} className={styles.creationPreview} data-axis={guideAxisForRuler('horizontal')} />
      <div ref={vPreviewElRef} className={styles.creationPreview} data-axis={guideAxisForRuler('vertical')} />
    </div>
  )
}
