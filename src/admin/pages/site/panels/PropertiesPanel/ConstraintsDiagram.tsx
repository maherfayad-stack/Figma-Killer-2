/**
 * ConstraintsDiagram — Figma's constraints crosshair, as PRESENTATION over
 * the honest side pickers that already ship beside it (W8-4).
 *
 * The widget is a square standing for the containing block, with a smaller
 * square standing for the element. Four bars pin the element to an edge; a
 * line through the middle of each axis centres it. Every click resolves
 * through `constraintMapping.ts` — this file owns pixels and pointer events,
 * that file owns what the CSS becomes. Nothing here derives a mapping rule
 * of its own.
 *
 * Three things it refuses to do
 * -----------------------------
 *   1. Claim constraints exist without a containing block.
 *      `resolvePositionedContext` gates the whole cluster: `fixed` is fine
 *      (the viewport), `absolute` is fine only when the PARENT really is the
 *      containing block, and an unverifiable parent stays disabled rather
 *      than assumed — the same "no frame, no claim" posture
 *      `resolveAlignWrite` takes for the align row.
 *   2. Centre by silently rewriting a `transform`/`translate` that already
 *      carries somebody's value. That refusal is named in the tooltip.
 *   3. Invent percentages for Scale. Percent insets are a measurement; with
 *      no frame reporting one, Scale renders disabled with the reason.
 *
 * Writes go through the SAME per-property `onChange`/`onClear` pair the side
 * pickers use, so the diagram never opens a second, competing write path.
 * One click can produce two or three property writes (e.g. stretch sets both
 * insets and clears `width`), which today lands as that many undo entries —
 * the panel's commit channel is per-property. Same limitation
 * `PositionConstraints` already documents for moving a value between sides.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { getParent } from '@core/page-tree'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import {
  AXIS_PROPERTIES,
  constraintRefusal,
  nextModeForEdgeToggle,
  planConstraintChange,
  readConstraintMode,
  resolvePositionedContext,
  type AxisGeometry,
  type ConstraintAxis,
  type ConstraintContext,
  type ConstraintMode,
} from './constraintMapping'
import { readString } from './styleValueUtils'
import styles from './ConstraintsDiagram.module.css'

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

const MODE_LABELS: Record<ConstraintAxis, Record<ConstraintMode, string>> = {
  x: { start: 'Left', end: 'Right', stretch: 'Left and right', center: 'Centre', scale: 'Scale' },
  y: { start: 'Top', end: 'Bottom', stretch: 'Top and bottom', center: 'Centre', scale: 'Scale' },
}

const EDGE_LABELS: Record<ConstraintAxis, Record<'start' | 'end', string>> = {
  x: { start: 'left', end: 'right' },
  y: { start: 'top', end: 'bottom' },
}

interface ConstraintsDiagramProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
}

export function ConstraintsDiagram({ storedStyles, currentStyles, onChange, onClear }: ConstraintsDiagramProps) {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const page = useEditorStore(selectActiveCanvasPage)
  const parentNode = selectedNodeId && page ? getParent(page, selectedNodeId) : undefined

  const nodeComputed = useFrameComputedStyleValues(selectedNodeId, activeBreakpointId, NODE_PROPERTIES)
  const parentComputed = useFrameComputedStyleValues(parentNode?.id ?? null, activeBreakpointId, PARENT_PROPERTIES)

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

  const xMode = readConstraintMode('x', contextFor('x'))
  const yMode = readConstraintMode('y', contextFor('y'))

  function apply(axis: ConstraintAxis, mode: ConstraintMode) {
    const plan = planConstraintChange(axis, mode, contextFor(axis))
    if (!plan.ok) return
    for (const [property, value] of Object.entries(plan.patch)) {
      if (value === null) onClear(property as keyof CSSPropertyBag)
      else onChange(property as keyof CSSPropertyBag, value)
    }
  }

  function edgeControl(axis: ConstraintAxis, edge: 'start' | 'end') {
    const current = axis === 'x' ? xMode : yMode
    const target = nextModeForEdgeToggle(current, edge)
    const pinned = current === edge || current === 'stretch'
    const side = EDGE_LABELS[axis][edge]
    const refusal = gate.ok ? constraintRefusal(axis, target, contextFor(axis)) : gate.reason
    return {
      pressed: pinned,
      disabled: refusal !== null,
      tooltip: refusal ?? `${pinned ? 'Unpin from' : 'Pin to'} the ${side} edge — ${MODE_LABELS[axis][target]}`,
      ariaLabel: `${pinned ? 'Unpin from' : 'Pin to'} ${side}`,
      onClick: () => apply(axis, target),
    }
  }

  function centerControl(axis: ConstraintAxis) {
    const current = axis === 'x' ? xMode : yMode
    const refusal = gate.ok ? constraintRefusal(axis, 'center', contextFor(axis)) : gate.reason
    const name = axis === 'x' ? 'horizontally' : 'vertically'
    return {
      pressed: current === 'center',
      disabled: refusal !== null,
      tooltip: refusal ?? `Centre ${name}`,
      ariaLabel: `Centre ${name}`,
      onClick: () => apply(axis, 'center'),
    }
  }

  const left = edgeControl('x', 'start')
  const right = edgeControl('x', 'end')
  const top = edgeControl('y', 'start')
  const bottom = edgeControl('y', 'end')
  const centreX = centerControl('x')
  const centreY = centerControl('y')

  return (
    <div
      className={styles.frame}
      role="group"
      aria-label={`Constraints. Horizontal: ${modeLabel('x', xMode)}. Vertical: ${modeLabel('y', yMode)}.`}
      data-disabled={gate.ok ? undefined : 'true'}
      data-testid="css-constraints-diagram"
    >
      <EdgeBar className={styles.edgeTop} orientation="vertical" control={top} testId="constraint-edge-top" />
      <EdgeBar className={styles.edgeLeft} orientation="horizontal" control={left} testId="constraint-edge-left" />
      <EdgeBar className={styles.edgeRight} orientation="horizontal" control={right} testId="constraint-edge-right" />
      <EdgeBar className={styles.edgeBottom} orientation="vertical" control={bottom} testId="constraint-edge-bottom" />
      <div className={styles.box} data-x-mode={xMode ?? 'none'} data-y-mode={yMode ?? 'none'}>
        <EdgeBar className={styles.centreY} orientation="vertical" control={centreY} testId="constraint-centre-y" />
        <span className={styles.centreYMirror} aria-hidden="true" />
        <EdgeBar className={styles.centreX} orientation="horizontal" control={centreX} testId="constraint-centre-x" />
      </div>
    </div>
  )
}

function modeLabel(axis: ConstraintAxis, mode: ConstraintMode | null): string {
  return mode ? MODE_LABELS[axis][mode] : 'not set'
}

interface EdgeBarControl {
  pressed: boolean
  disabled: boolean
  tooltip: string
  ariaLabel: string
  onClick: () => void
}

/** One clickable line in the crosshair. The `<span>` is the line; the button is the hit area. */
function EdgeBar({
  className,
  orientation,
  control,
  testId,
}: {
  className: string
  orientation: 'vertical' | 'horizontal'
  control: EdgeBarControl
  testId: string
}) {
  return (
    <Button
      variant="ghost"
      size="micro"
      className={cn(styles.bar, className)}
      pressed={control.pressed}
      disabled={control.disabled}
      tooltip={control.tooltip}
      aria-label={control.ariaLabel}
      data-testid={testId}
      onClick={control.onClick}
    >
      <span className={orientation === 'vertical' ? styles.lineV : styles.lineH} aria-hidden="true" />
    </Button>
  )
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
