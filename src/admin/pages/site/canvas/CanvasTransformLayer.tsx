/**
 * CanvasTransformLayer — the div that receives the CSS transform.
 *
 * This is the ONLY element whose style.transform is mutated during pan/zoom.
 * It contains all BreakpointFrames positioned side-by-side.
 *
 * Performance note: CSS transform (translate + scale) is composited on the GPU.
 * Mutating its `style.transform` via a ref (not React state) avoids React re-renders.
 * See useCanvas.ts for the RAF-batched write pattern.
 */

import { lazy, Suspense, type Ref } from 'react'
import { DEFAULT_BREAKPOINTS, type Page, type Breakpoint } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { BreakpointFrame } from './BreakpointFrame'
import { CanvasFrameSkeletonFrame } from '@admin/shared/CanvasFrameSkeleton'
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import styles from './CanvasTransformLayer.module.css'

// Studio-only board overlay layers (frames, sticky notes, doc blocks, snap
// guides) — see StudioBoardLayers.tsx. All four self-gate to `null` outside
// an active board, so this lazy boundary only changes WHEN the chunk is
// fetched, not what renders: `activeBoard` is always `null` in the default
// (non-Studio) CMS editor.
const StudioBoardLayers = lazy(() =>
  import('./StudioBoardLayers').then((m) => ({ default: m.StudioBoardLayers })),
)

interface CanvasTransformLayerProps {
  page: Page | null
  breakpoints: Breakpoint[]
  activeBreakpointId: string
  dimInactiveBreakpoints?: boolean
  activationHintEnabled?: boolean
  onBreakpointActivate: (id: string) => void
  templateContext?: TemplateRenderDataContext
  /** Opt-in runtime scripts injected into every frame; empty/undefined = none. */
  runtimeScripts?: InjectableRuntimeScript[]
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLDivElement>
}

export function CanvasTransformLayer({
  page,
  breakpoints,
  activeBreakpointId,
  dimInactiveBreakpoints = false,
  activationHintEnabled = false,
  onBreakpointActivate,
  templateContext,
  runtimeScripts,
  ref,
}: CanvasTransformLayerProps) {
  const framedBreakpoints: Breakpoint[] = []
  for (const breakpoint of breakpoints) {
    if (breakpoint.previewFrame !== false) framedBreakpoints.push(breakpoint)
  }
  const fallbackBreakpoints = framedBreakpoints.length > 0 ? framedBreakpoints : DEFAULT_BREAKPOINTS

  // Studio board mode: an active board means we're rendering the multi-frame
  // board (Phase 1, Increment 1B) — every workspace page as its own
  // positioned frame — instead of this single page's breakpoint frames. `null`
  // (CMS / Visual Component editing, the default) renders exactly as before.
  const activeBoard = useEditorStore(selectActiveBoard)

  return (
    <div
      ref={ref}
      data-testid="canvas-transform-layer"
      // GPU promotion (will-change) is applied imperatively + transiently by
      // useCanvas during active gestures — not permanently — to avoid wrapping
      // the whole subtree into one oversized layer backing that leaves content
      // blank at scale/low zoom. See WILL_CHANGE_RELEASE_MS in useCanvas.ts.
      className={styles.transformLayer}
    >
      {activeBoard ? (
        <Suspense fallback={null}>
          <StudioBoardLayers />
        </Suspense>
      ) : page ? (
        // Only breakpoints flagged for a preview frame render an iframe on the
        // canvas (`previewFrame !== false`; undefined = framed for back-compat).
        // Frame-less breakpoints are still selectable editing contexts in the
        // toolbar switcher and still publish their @media CSS — they just don't
        // spawn an editor iframe.
        //
        // All frames mount as soon as the page document is in the store: the
        // tree is already in memory, so there's no async load to stagger. The
        // skeletons above cover the only genuine wait — the document not being
        // loaded yet (`page === null`).
        framedBreakpoints.map((bp) => (
          <BreakpointFrame
            key={bp.id}
            page={page}
            breakpoint={bp}
            isActive={activeBreakpointId === bp.id}
            isDimmed={dimInactiveBreakpoints && activeBreakpointId !== bp.id}
            activationHintEnabled={activationHintEnabled}
            onActivate={onBreakpointActivate}
            templateContext={templateContext}
            runtimeScripts={runtimeScripts}
          />
        ))
      ) : (
        fallbackBreakpoints.map((breakpoint) => (
          <CanvasFrameSkeletonFrame
            key={breakpoint.id}
            breakpoint={breakpoint}
            dimmed={dimInactiveBreakpoints && activeBreakpointId !== breakpoint.id}
          />
        ))
      )}
    </div>
  )
}
