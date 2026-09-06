/**
 * resolveAlignWrite — the honest single-CSS-write check behind every
 * `PositionSection` align button (G10, STUDIO-INSPECTOR-DISCLOSURE-PLAN.md).
 *
 * Pulled out of `PositionSection.tsx` into its own module (not just a
 * section of that file) because `react-refresh/only-export-components`
 * requires a component file to export components only — this is pure logic
 * with no JSX, so it belongs in a plain module regardless.
 */
import type { AlignEdge } from '@ui/components/AlignBar'

/** The selected node's real parent, as read off a live canvas frame. */
export interface ParentLayoutInfo {
  display: string
  flexDirection: string
  /** `parent.children.length` — includes the selected node itself. */
  siblingCount: number
}

export type AlignResolution =
  | { target: 'self'; property: 'alignSelf' | 'justifySelf'; value: string }
  | { target: 'parent'; property: 'justifyContent'; value: string }
  | { target: 'unavailable'; reason: string }

export const ALL_ALIGN_EDGES: readonly AlignEdge[] = ['left', 'center', 'right', 'top', 'middle', 'bottom']

const EDGE_AXIS: Record<AlignEdge, 'horizontal' | 'vertical'> = {
  left: 'horizontal',
  center: 'horizontal',
  right: 'horizontal',
  top: 'vertical',
  middle: 'vertical',
  bottom: 'vertical',
}

/**
 * `flex-start | center | flex-end` — the same self-position keywords used
 * for BOTH flex and grid alignment elsewhere in this panel (see
 * `GridAxisControl`'s doc: both layouts accept these per CSS Box Alignment
 * Module 3, so one vocabulary keeps the visual language consistent when a
 * class toggles between `display: flex` and `display: grid`).
 */
const EDGE_VALUE: Record<AlignEdge, string> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
}

/**
 * Resolves ONE align edge to an honest single CSS write, or explains why
 * none exists. Never guesses:
 *
 *   - Grid parent: every edge has a per-item override (`justifySelf` for
 *     the horizontal edges, `alignSelf` for the vertical ones) — CSS Grid
 *     supports both axes per item, so this is always honest regardless of
 *     how many siblings share the container.
 *   - Flex parent, CROSS axis (perpendicular to `flexDirection`): honest
 *     via `alignSelf` on the node itself, always — a per-item override,
 *     unaffected by siblings.
 *   - Flex parent, MAIN axis (parallel to `flexDirection`): flexbox has no
 *     per-item main-axis override. Honest ONLY when this node is the
 *     parent's only child — then the parent's `justifyContent` affects
 *     exactly this one node, so writing it there is a single, honest write.
 *     With siblings present, no single CSS write exists — disabled with a
 *     reason rather than silently moving every sibling.
 *   - Anything else (no parent, no live frame, or a parent that isn't a
 *     flex/grid container): disabled — align has no meaning without a
 *     flex/grid parent to align within.
 */
export function resolveAlignWrite(edge: AlignEdge, parent: ParentLayoutInfo | null): AlignResolution {
  if (!parent) {
    return { target: 'unavailable', reason: "Can't verify the parent's layout." }
  }
  const axis = EDGE_AXIS[edge]
  if (parent.display === 'grid') {
    const property = axis === 'horizontal' ? 'justifySelf' : 'alignSelf'
    return { target: 'self', property, value: EDGE_VALUE[edge] }
  }
  if (parent.display === 'flex') {
    const mainAxis: 'horizontal' | 'vertical' = parent.flexDirection.startsWith('column') ? 'vertical' : 'horizontal'
    if (axis !== mainAxis) {
      return { target: 'self', property: 'alignSelf', value: EDGE_VALUE[edge] }
    }
    if (parent.siblingCount <= 1) {
      return { target: 'parent', property: 'justifyContent', value: EDGE_VALUE[edge] }
    }
    return {
      target: 'unavailable',
      reason: `${parent.siblingCount} children share this axis in the flex parent — aligning only this one isn't a single CSS write here.`,
    }
  }
  return { target: 'unavailable', reason: "Align needs a flex or grid parent — set the parent's layout first." }
}
