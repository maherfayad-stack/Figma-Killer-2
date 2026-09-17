/**
 * ConstraintsDiagram — Figma's constraints crosshair. The square stands for
 * the containing block and the smaller square inside it for the element;
 * four bars pin the element to an edge and a line through the middle of each
 * axis centres it.
 *
 * The crosshair and the per-axis constraint dropdowns beside it
 * (`PositionConstraints`) are two faces of ONE model. Everything either of
 * them knows comes from `useConstraintAxes` — the gate, the current mode per
 * axis, every named refusal, and the single-patch write — which in turn owns
 * nothing but the frame reads `constraintMapping.ts` needs. This file owns
 * pixels and pointer events and nothing else; it derives no mapping rule of
 * its own and reads no store.
 *
 * Clicking an edge is Figma's toggle, stated once as data in
 * `nextModeForEdgeToggle`: an unpinned edge pins (pairing with an
 * already-pinned opposite edge to stretch), a pinned edge un-pins, and the
 * last pin coming off drops the axis to Scale. Scale is drawn as dashed box
 * edges so it is distinguishable from having no constraint at all.
 *
 * Three things it refuses to do
 * -----------------------------
 *   1. Claim constraints exist without a containing block. The gate is
 *      `resolvePositionedContext`: `fixed` is fine (the viewport), `absolute`
 *      is fine only when the PARENT really is the containing block, and an
 *      unverifiable parent stays disabled rather than assumed — the same "no
 *      frame, no claim" posture `resolveAlignWrite` takes for the align row.
 *   2. Centre by silently rewriting a `transform`/`translate` that already
 *      carries somebody's value. That refusal is named in the tooltip.
 *   3. Invent percentages for Scale. Percent insets are a measurement; with
 *      no frame reporting one, Scale renders disabled with the reason.
 */
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { nextModeForEdgeToggle, type ConstraintAxis, type ConstraintMode } from './constraintMapping'
import { CONSTRAINT_MODE_LABELS } from './constraintModeLabels'
import type { ConstraintAxesApi } from './useConstraintAxes'
import styles from './ConstraintsDiagram.module.css'

const EDGE_LABELS: Record<ConstraintAxis, Record<'start' | 'end', string>> = {
  x: { start: 'left', end: 'right' },
  y: { start: 'top', end: 'bottom' },
}

interface ConstraintsDiagramProps {
  axes: ConstraintAxesApi
}

export function ConstraintsDiagram({ axes }: ConstraintsDiagramProps) {
  const xMode = axes.modeFor('x')
  const yMode = axes.modeFor('y')

  function edgeControl(axis: ConstraintAxis, edge: 'start' | 'end') {
    const current = axis === 'x' ? xMode : yMode
    const target = nextModeForEdgeToggle(current, edge)
    const pinned = current === edge || current === 'stretch'
    const side = EDGE_LABELS[axis][edge]
    const refusal = axes.refusalFor(axis, target)
    return {
      pressed: pinned,
      disabled: refusal !== null,
      tooltip: refusal ?? `${pinned ? 'Unpin from' : 'Pin to'} the ${side} edge — ${CONSTRAINT_MODE_LABELS[axis][target]}`,
      ariaLabel: `${pinned ? 'Unpin from' : 'Pin to'} ${side}`,
      onClick: () => axes.applyMode(axis, target),
    }
  }

  function centerControl(axis: ConstraintAxis) {
    const current = axis === 'x' ? xMode : yMode
    const refusal = axes.refusalFor(axis, 'center')
    const name = axis === 'x' ? 'horizontally' : 'vertically'
    return {
      pressed: current === 'center',
      disabled: refusal !== null,
      tooltip: refusal ?? `Centre ${name}`,
      ariaLabel: `Centre ${name}`,
      onClick: () => axes.applyMode(axis, 'center'),
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
      data-disabled={axes.gate.ok ? undefined : 'true'}
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
  return mode ? CONSTRAINT_MODE_LABELS[axis][mode] : 'not set'
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
