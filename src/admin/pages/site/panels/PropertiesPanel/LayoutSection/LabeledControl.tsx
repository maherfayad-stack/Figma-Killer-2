/**
 * LabeledControl — one flex / grid sub-field, with an optional caption above it.
 *
 * This used to be a side-label row on the same `--control-label-w` gutter as
 * `ControlRow`'s inline layout, which left the Layout block as the last place
 * in the panel still spending 68px of every row on a word. It now speaks the
 * inspector's own vocabulary — a small caption stacked above a full-width
 * control, or no caption at all.
 *
 * `label` is optional, and omitting it is the point rather than an oversight:
 * a row of direction arrows or wrap marks is a picture that already says what
 * it is, and captioning it prints the same name twice. The controls that KEEP
 * a caption are the ones where the picture alone is genuinely ambiguous —
 * "Align" versus "Justify" are two identical-looking icon groups, and
 * "Columns" versus "Rows" are two identical-looking track fields. Each control
 * still carries its full name in `aria-label` either way.
 */

import type { ReactNode } from 'react'
import styles from '../LayoutSection.module.css'

interface LabeledControlProps {
  /** Caption above the control. Omit when the control names itself. */
  label?: string
  /**
   * Whether the underlying CSS property has a value set. Toggles the caption
   * between brighter (set) and muted (unset) — same set/unset language as
   * ClassPropertyRow so visual switchers and generic property rows share a
   * single visual cue for "this property is/isn't set".
   */
  isSet?: boolean
  children: ReactNode
}

export function LabeledControl({ label, isSet, children }: LabeledControlProps) {
  return (
    <div className={styles.labeledRow} data-state={isSet ? 'set' : 'unset'}>
      {label !== undefined && <span className={styles.labeledLabel}>{label}</span>}
      <div className={styles.labeledControl}>{children}</div>
    </div>
  )
}
