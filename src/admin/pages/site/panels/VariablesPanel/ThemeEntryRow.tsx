/**
 * ThemeEntryRow - one value a JavaScript theme defines, read-only (CT-6).
 *
 * A Tailwind v3 config's `theme.extend.colors.primary` or a `theme.ts` token
 * is not a CSS variable and Studio never runs the file that defines it, so
 * there is nothing here to edit and the row does not pretend otherwise: the
 * value is plain text, a lock says why, and the one thing that CAN be done -
 * adding its utility class to the selected element - is a button. "Why" opens
 * the server's sentence: exactly why the value is not edited here and what to
 * do instead.
 */
import { useState, type CSSProperties } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import type { JsThemeEntry } from '@core/studio-tokens'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { ApplyClassStrip } from './ApplyClassStrip'
import { themeEntryLabel } from './variablesModel'
import styles from './ThemeEntryRow.module.css'

interface ThemeEntryRowProps {
  entry: JsThemeEntry
  /** Why no class can be applied to the selection right now, or `null`. */
  applyBlockedReason: string | null
  busy: boolean
  onApply: (className: string) => Promise<void>
}

export function ThemeEntryRow({ entry, applyBlockedReason, busy, onApply }: ThemeEntryRowProps) {
  const [showWhy, setShowWhy] = useState(false)
  const [showApply, setShowApply] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = themeEntryLabel(entry)
  const isColor = entry.family === 'color' && entry.value !== null

  async function apply(className: string) {
    setError(null)
    try {
      await onApply(className)
    } catch (err) {
      console.error('[ThemeEntryRow] could not apply the class:', err)
      setError(getErrorMessage(err, `${className} could not be applied.`))
    }
  }

  return (
    <li className={styles.row} data-testid={`theme-entry-${entry.id}`}>
      <div className={styles.nameCell}>
        <span className={styles.name} title={entry.readOnlyReason}>
          {label}
        </span>
        <span className={styles.where}>
          {entry.file}:{entry.line}
        </span>
      </div>

      <span className={styles.value} title={entry.readOnlyReason}>
        {isColor ? <span className={styles.swatch} style={{ '--swatch': entry.value } as CSSProperties} /> : null}
        <span className={entry.value === null ? `${styles.valueText} ${styles.computed}` : styles.valueText}>{entry.value ?? entry.raw}</span>
      </span>

      <div className={styles.actions}>
        {entry.utilities.length > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label={`Apply ${label} as a class`}
            tooltip="Apply as a class"
            pressed={showApply}
            onClick={() => setShowApply(!showApply)}
          >
            <CodeIcon size={11} aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Why ${label} is read-only`}
          tooltip="Why is this read-only?"
          pressed={showWhy}
          onClick={() => setShowWhy(!showWhy)}
        >
          <LockSolidIcon size={11} aria-hidden="true" />
        </Button>
      </div>

      {showWhy ? <p className={styles.note}>{entry.readOnlyReason}</p> : null}
      {showApply ? <ApplyClassStrip subject={label} classes={entry.utilities} blockedReason={applyBlockedReason} busy={busy} onApply={apply} /> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </li>
  )
}
