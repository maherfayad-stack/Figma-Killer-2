import type { RefObject } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { resolveRulerOriginBoard } from './rulerGeometry'
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
 */
export function CanvasRulers({ canvasRootRef, transformRef }: CanvasRulersProps) {
  const activeBoard = useEditorStore(selectActiveBoard)
  const addGuide = useEditorStore((s) => s.addGuide)
  const origin = resolveRulerOriginBoard(activeBoard)

  const onCreate = activeBoard ? (axis: 'x' | 'y', position: number) => addGuide(axis, position) : null

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
  const { previewElRef: hPreviewElRef, onPointerDown: hOnPointerDown } = useRulerGuideCreation({
    axis: 'x',
    canvasRootRef,
    transformRef,
    onCreate,
  })
  const { previewElRef: vPreviewElRef, onPointerDown: vOnPointerDown } = useRulerGuideCreation({
    axis: 'y',
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
      <div ref={hPreviewElRef} className={styles.creationPreview} data-axis="x" />
      <div ref={vPreviewElRef} className={styles.creationPreview} data-axis="y" />
    </div>
  )
}
