/**
 * InPlaceInspectorAnchor — the positioned wrapper the in-place mini-inspector
 * renders inside. `BreakpointSelectionOverlay` owns WHERE it goes (its measure
 * pass calls `positionInspector` through `anchorRef`, and the pan/zoom
 * follower re-projects it on every transform write); this component is only
 * the element. Split out of the overlay when PERF-3 took it past its
 * `module-size-budgets` ceiling.
 *
 * `InPlaceInspector` independently bails to null for a non-`alm.*` node, so
 * the wrapper mounts for any single studio selection and the inspector itself
 * decides whether to render anything.
 */
import type { RefObject } from 'react'
import { InPlaceInspector } from './InPlaceInspector'
import styles from './BreakpointSelectionOverlay.module.css'

interface InPlaceInspectorAnchorProps {
  anchorRef: RefObject<HTMLDivElement | null>
  nodeId: string
  mode: 'scoped' | 'fixed'
  breakpointId: string
}

export function InPlaceInspectorAnchor({ anchorRef, nodeId, mode, breakpointId }: InPlaceInspectorAnchorProps) {
  return (
    <div
      ref={anchorRef}
      className={styles.inspectorAnchor}
      data-canvas-in-place-inspector="true"
      data-canvas-inspector-mode={mode}
      // Debugging aid: every studio board frame mounts its OWN wrapper, so
      // several of these can exist in the DOM at once with only one actually
      // positioned/visible — this tells them apart without React internals.
      data-canvas-inspector-breakpoint={breakpointId}
      // Same rationale as the toolbar's onClick guard: the inspector is
      // portaled into the canvas root, whose background click clears the
      // selection — without this guard, clicking a control inside it would
      // bubble up and clear the selection mid-edit.
      onClick={(event) => event.stopPropagation()}
    >
      <InPlaceInspector nodeId={nodeId} />
    </div>
  )
}
