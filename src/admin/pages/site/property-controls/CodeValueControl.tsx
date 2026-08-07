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
 * every code-valued prop. `hint` (built by `propLockReason`, which now names
 * this PROP's own resolved source — R2 — rather than a generic node-level
 * fallback) moves into a lock glyph's tooltip instead: the fact is still one
 * hover away, but the row reads as "value, plus a small badge" rather than
 * "value, plus a paragraph".
 */
import type { ControlProps } from './shared'
import { ControlRow } from '@ui/components/ControlRow'
import { Button } from '@ui/components/Button'
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
   * Why this value cannot be edited, shown after the value itself. Defaults to
   * the structured-value case, which needs no node-level explanation.
   */
  hint?: string
}

export function CodeValueControl({
  propKey,
  value,
  label,
  isOverride,
  layout,
  hint = 'set in code',
}: CodeValueControlProps) {
  return (
    <ControlRow propKey={propKey} label={label} layout={layout} isOverride={isOverride} disabled>
      <span className={styles.codeValue} data-testid={`code-value-${propKey}`}>
        <span className={styles.codeValueText}>{summariseValue(value)}</span>
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          tooltip={hint}
          aria-label={`Why this value is read-only: ${hint}`}
          className={styles.codeValueGlyph}
        >
          <LockSolidIcon size={11} />
        </Button>
      </span>
    </ControlRow>
  )
}
