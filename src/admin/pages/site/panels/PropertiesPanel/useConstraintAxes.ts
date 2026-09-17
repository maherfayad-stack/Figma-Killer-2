/**
 * useConstraintAxes — the ONE live binding between `constraintMapping.ts`'s
 * pure model and the two surfaces that render it: the per-axis constraint
 * dropdowns (`PositionConstraints`) and the crosshair (`ConstraintsDiagram`).
 *
 * Both surfaces used to be able to disagree, because only the crosshair read
 * the frame. It owned the store subscription, the two `getComputedStyle`
 * reads, the containing-block gate and the percent geometry; the pickers
 * beside it knew nothing about any of that and offered a two-option
 * `Left ▾ / Right ▾` side picker instead of Figma's five constraints. Moving
 * all of it here makes "which constraint is this axis in" a single answer
 * both controls read, and leaves each component owning only pixels.
 *
 * Nothing about the MAPPING lives here. `constraintMapping.ts` still owns
 * read-back, the patch for a constraint choice, and every named refusal;
 * this hook only supplies that module the three things it cannot compute
 * itself — the element's live insets, its parent's padding box, and whether
 * the parent really is the containing block.
 *
 * ## One constraint change is now ONE undo entry
 *
 * `ConstraintsDiagram` used to replay a plan property by property through the
 * panel's per-property `onChange`/`onClear` pair, so "stretch" (two insets
 * plus a cleared size) landed as three history entries — the limitation
 * `docs/features/inspector.md` §G10.3 recorded as "inherited, not
 * introduced". The inspector's commit API has had `commitStyleMany` since P4,
 * so this hook takes a patch-shaped `onChangeMany` and the whole plan commits
 * at once.
 */
import { getParent } from '@core/page-tree'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import {
  AXIS_PROPERTIES,
  constraintRefusal,
  planConstraintChange,
  readConstraintMode,
  resolvePositionedContext,
  type AxisGeometry,
  type ConstraintAxis,
  type ConstraintContext,
  type ConstraintMode,
  type PositionedContext,
} from './constraintMapping'
import { readString } from './styleValueUtils'

/** Computed properties read off the node's own live element. */
const NODE_PROPERTIES = ['position', 'left', 'right', 'top', 'bottom', 'translate', 'transform'] as const

/**
 * Computed properties read off the PARENT's live element. `width`/`height`
 * plus the paddings reconstruct the padding box, which is exactly the
 * containing block an absolutely positioned child resolves its percentages
 * against.
 */
const PARENT_PROPERTIES = [
  'position',
  'transform',
  'width',
  'height',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
] as const

export interface ConstraintAxesApi {
  /** Whether constraints mean anything at all for this element, and why not when they don't. */
  gate: PositionedContext
  /** Which constraint this axis is currently in, per what the edited bag declares. */
  modeFor(axis: ConstraintAxis): ConstraintMode | null
  /** Why this mode has no honest patch on this axis, or `null` when it does. Carries the gate's own reason. */
  refusalFor(axis: ConstraintAxis, mode: ConstraintMode): string | null
  /** Commit the whole constraint change as one patch, or do nothing when it is refused. */
  applyMode(axis: ConstraintAxis, mode: ConstraintMode): void
}

interface UseConstraintAxesInput {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  /** One patch, one history entry — see this module's doc. */
  onChangeMany: (patch: Record<string, string | null>) => void
}

export function useConstraintAxes({
  storedStyles,
  currentStyles,
  onChangeMany,
}: UseConstraintAxesInput): ConstraintAxesApi {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const page = useEditorStore(selectActiveCanvasPage)
  const parentNode = selectedNodeId && page ? getParent(page, selectedNodeId) : undefined

  const { value: nodeComputed } = useFrameComputedStyleValues(selectedNodeId, activeBreakpointId, NODE_PROPERTIES)
  const { value: parentComputed } = useFrameComputedStyleValues(
    parentNode?.id ?? null,
    activeBreakpointId,
    PARENT_PROPERTIES,
  )

  const position = readString(currentStyles, 'position') ?? nodeComputed?.position ?? null
  const gate = resolvePositionedContext({
    position,
    parentIsContainingBlock: parentComputed ? isContainingBlock(parentComputed) : null,
  })

  // Percent insets are only measurable against the PARENT's padding box, so
  // geometry exists only for the `absolute` case the gate accepts. A `fixed`
  // element resolves against the viewport, which this read does not measure —
  // Scale then refuses by name rather than converting against the wrong box.
  const geometry =
    gate.ok && position === 'absolute' && nodeComputed && parentComputed
      ? { x: axisGeometry(nodeComputed, parentComputed, 'x'), y: axisGeometry(nodeComputed, parentComputed, 'y') }
      : { x: null, y: null }

  const contextFor = (axis: ConstraintAxis): ConstraintContext => ({
    stored: storedStyles,
    current: { ...currentStyles, ...(nodeComputed ?? {}) },
    geometry: geometry[axis],
  })

  return {
    gate,
    modeFor: (axis) => readConstraintMode(axis, contextFor(axis)),
    refusalFor: (axis, mode) => (gate.ok ? constraintRefusal(axis, mode, contextFor(axis)) : gate.reason),
    applyMode: (axis, mode) => {
      if (!gate.ok) return
      const plan = planConstraintChange(axis, mode, contextFor(axis))
      if (!plan.ok) return
      onChangeMany(plan.patch)
    },
  }
}

/** A parent is the containing block when it is positioned, or when a transform makes it one. */
function isContainingBlock(parentComputed: Record<string, string>): boolean {
  if (parentComputed.position && parentComputed.position !== 'static') return true
  return parentComputed.transform !== '' && parentComputed.transform !== 'none'
}

/**
 * One axis of live geometry: the element's used insets, and the parent's
 * PADDING box along that axis (content size plus both paddings) — the box
 * an absolutely positioned child's percentages resolve against. Returns
 * `null` when any of it is unreadable, never a zero standing in for unknown.
 */
function axisGeometry(
  nodeComputed: Record<string, string>,
  parentComputed: Record<string, string>,
  axis: ConstraintAxis,
): AxisGeometry | null {
  const props = AXIS_PROPERTIES[axis]
  const startPx = toPx(nodeComputed[props.start])
  const endPx = toPx(nodeComputed[props.end])
  const containerPx =
    axis === 'x'
      ? sumPx(parentComputed.width, parentComputed.paddingLeft, parentComputed.paddingRight)
      : sumPx(parentComputed.height, parentComputed.paddingTop, parentComputed.paddingBottom)
  if (startPx === null || endPx === null || containerPx === null) return null
  return { startPx, endPx, containerPx }
}

function toPx(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sumPx(...values: Array<string | undefined>): number | null {
  let total = 0
  for (const value of values) {
    const px = toPx(value)
    if (px === null) return null
    total += px
  }
  return total
}
