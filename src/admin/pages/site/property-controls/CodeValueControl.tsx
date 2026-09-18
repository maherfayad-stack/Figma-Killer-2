/**
 * CodeValueControl — the read-only stand-in for a prop this panel cannot write.
 *
 * Two different situations produce a value that is real, worth showing, and not
 * editable here. Both get the same surface, because to the user they are the
 * same fact — "this came from the code":
 *
 *  1. **A structured value.** Every other control in this folder edits a scalar.
 *     An array/object reaches a node only from imported source
 *     (`<ActionSheet actions={[{ label }, …]}/>` — see `ParsedPropValue` in
 *     `@core/page-parser`), and there is no source location an edit could land
 *     on: `setJsxProp` writes a scalar initializer, and the studio save path
 *     filters to scalars before it gets there.
 *
 *  2. **A code-valued prop.** The value was resolved from an expression, or the
 *     node is a `.map` row with no isolated source location, so
 *     `updateNodeProps` refuses the write (see `SourceConstraintNotice` for the
 *     full reasoning). This is per-PROP: its literal siblings on the same node
 *     stay editable, and the node itself is usually not locked at all.
 *
 * In both cases an editable-looking input is a lie. Case 1 previously rendered
 * `[object Object]` in a text box where one keystroke replaced a whole array of
 * actions with that string; case 2 rendered the real copy in a text box that
 * silently discarded everything typed into it.
 *
 * Track F2 / R1-R2's "per-field design" — the WHY used to be a permanent
 * inline `· set in code` string appended to the value, eating row width on
 * every code-valued prop. The lock glyph moved that fact one hover away first
 * (a passive tooltip); R3 (`STUDIO-LIVE-CANVAS-PLAN.md` Track R) goes one step
 * further: the glyph is now a real, click-to-open `InspectorPopover` (the same
 * primitive `LayoutSettingsButton` uses), because a hover tooltip has no room
 * for a remedy BUTTON — and `explainPropConstraint`'s `list-row` case has a
 * real one (`edit-array`, via `ConstraintActionButtons` — the identical
 * renderer the layers-context-menu footer and the structural lock banner use).
 * The trigger keeps a static `aria-label` naming the reason, so the fact is
 * still discoverable without opening the popover.
 */
import { useRef, useState } from 'react'
import type { EditConstraint } from '@core/page-tree'
import type { ControlProps } from './shared'
import { ControlRow } from '@ui/components/ControlRow'
import { Button } from '@ui/components/Button'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { ConstraintActionButtons } from '@site/ui/ConstraintNotice'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import styles from './controls.module.css'

/** Longest scalar shown inline before it is clipped — this is a 100px-labelled row. */
const MAX_SCALAR_LENGTH = 60

/**
 * What to show in place of an input.
 *
 * For a structured value this is deliberately the SHAPE, not the content: the
 * point is "this prop holds 2 actions, defined in code", not reproducing a JSON
 * blob in a narrow row. For a scalar it is the value itself — the user is
 * looking at their own copy and needs to recognise it.
 */
function summariseValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 1 ? '1 item' : `${value.length} items`
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    if (keys.length === 0) return 'empty object'
    return keys.length <= 3 ? keys.join(', ') : `${keys.slice(0, 3).join(', ')} +${keys.length - 3}`
  }
  if (value === undefined || value === null || value === '') return '—'
  const text = String(value)
  return text.length > MAX_SCALAR_LENGTH ? `${text.slice(0, MAX_SCALAR_LENGTH - 1)}…` : text
}

interface CodeValueControlProps extends ControlProps<unknown> {
  /**
   * Why this value cannot be edited, and any real way forward.
   * `explainPropConstraint` builds this; absent for the one case that carries
   * no `EditConstraint` at all — a writable-but-structured value (see
   * `PropertyControlRenderer`'s `isStructuredValue` gate) — which falls back
   * to the generic "Set in code." below.
   */
  constraint?: EditConstraint
}

export function CodeValueControl({
  propKey,
  value,
  label,
  isOverride,
  layout,
  constraint,
}: CodeValueControlProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const explanation = constraint?.explanation ?? 'Set in code.'

  return (
    <ControlRow propKey={propKey} label={label} layout={layout} isOverride={isOverride} disabled>
      <span className={styles.codeValue} data-testid={`code-value-${propKey}`}>
        <span className={styles.codeValueText}>{summariseValue(value)}</span>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="micro"
          iconOnly
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Why this value is read-only: ${explanation}`}
          className={styles.codeValueGlyph}
          onClick={() => setOpen((o) => !o)}
        >
          <LockSolidIcon size={11} />
        </Button>
        {open && (
          <InspectorPopover
            id={`code-value-${propKey}`}
            anchorRef={triggerRef}
            onClose={() => setOpen(false)}
            title="Read-only"
            width={220}
          >
            <p className={styles.codeValueHint}>{explanation}</p>
            {constraint && <ConstraintActionButtons constraint={constraint} />}
          </InspectorPopover>
        )}
      </span>
    </ControlRow>
  )
}
