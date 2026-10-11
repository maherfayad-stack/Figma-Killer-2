/**
 * ApplyClassStrip - the utility classes that apply a theme value to the
 * selected element (CT-6).
 *
 * A Tailwind theme value is applied the way its author writes it: by adding
 * `bg-primary` to the element's `className`. Each class is one button; the
 * write is the class codemod, so it lands in exactly one attribute per element
 * or is refused with its reason. When there is nothing to write to (no
 * selection, an element with no place in the source) the strip says so instead
 * of offering buttons that cannot work.
 */
import { Button } from '@ui/components/Button'
import styles from './ApplyClassStrip.module.css'

interface ApplyClassStripProps {
  /** What the classes apply: a variable or theme path, for the accessible names. */
  subject: string
  classes: readonly string[]
  /** Why nothing can be applied right now, or `null`. */
  blockedReason: string | null
  busy: boolean
  onApply: (className: string) => Promise<void>
}

export function ApplyClassStrip({ subject, classes, blockedReason, busy, onApply }: ApplyClassStripProps) {
  return (
    <div className={styles.strip} role="group" aria-label={`Apply ${subject} as a class`}>
      <span className={styles.label}>Apply to selection:</span>
      {classes.map((className) => (
        <Button key={className} variant="ghost" size="xs" disabled={busy || blockedReason !== null} onClick={() => void onApply(className)}>
          <span className={styles.className}>{className}</span>
        </Button>
      ))}
      {blockedReason ? <p className={styles.blocked}>{blockedReason}</p> : null}
    </div>
  )
}
