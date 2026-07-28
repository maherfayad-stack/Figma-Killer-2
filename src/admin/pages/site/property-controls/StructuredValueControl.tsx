/**
 * StructuredValueControl — the read-only stand-in for a prop whose value is an
 * array or an object.
 *
 * Every other control in this folder edits a scalar. A structured value reaches
 * a node only from imported source (`<ActionSheet actions={[{ label }, …]}/>` —
 * see `ParsedPropValue` in `@core/page-parser`), and there is no source location
 * an edit could land on: `setJsxProp` writes a scalar initializer, and the studio
 * save path filters to scalars before it ever gets there.
 *
 * So the honest surface is a summary, not an input. Rendering the usual
 * `TextControl` here put `[object Object]` in a text box and let one keystroke
 * replace a whole array of actions with that string.
 */
import type { ControlProps } from './shared'
import { ControlRow } from '@ui/components/ControlRow'
import styles from './controls.module.css'

/**
 * A one-line shape summary. Deliberately shape, not content: the point is to say
 * "this prop holds 2 actions, defined in code", not to reproduce a JSON blob in
 * a 100px-labelled row.
 */
function summariseStructuredValue(value: readonly unknown[] | Record<string, unknown>): string {
  if (Array.isArray(value)) {
    return value.length === 1 ? '1 item' : `${value.length} items`
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return 'empty object'
  return keys.length <= 3 ? keys.join(', ') : `${keys.slice(0, 3).join(', ')} +${keys.length - 3}`
}

export function StructuredValueControl({
  propKey,
  value,
  label,
  isOverride,
  layout,
}: ControlProps<readonly unknown[] | Record<string, unknown>>) {
  return (
    <ControlRow propKey={propKey} label={label} layout={layout} isOverride={isOverride} disabled>
      <span className={styles.structuredValue} data-testid={`structured-value-${propKey}`}>
        {summariseStructuredValue(value)}
        <span className={styles.structuredValueHint}> · set in code</span>
      </span>
    </ControlRow>
  )
}
