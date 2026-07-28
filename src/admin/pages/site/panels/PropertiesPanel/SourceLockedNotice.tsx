/**
 * SourceLockedNotice — explains what the source does to the selected element, and
 * which of its values that does or does not put out of reach.
 *
 * A Studio-imported node is source-locked when the source does not simply place
 * it: a `.map` generated it, a ternary or `&&` chose it, a spread feeds it, or a
 * value on it came from an expression (`{c.hotelsTitle}`) rather than a literal.
 *
 * The wording matters because the honest answer differs per element, and the
 * previous version of this notice gave only the pessimistic one ("Set in code.
 * Edit the source file to change it") for all of them. That was wrong for most:
 * a conditional's branch is an ordinary element at a known line, and its literal
 * attributes are precisely writable. What is genuinely unwritable is narrower —
 * an individual expression-backed prop (marked "set in code" on its own row), and
 * every prop on a `.map` row, which has no source location of its own because one
 * piece of JSX renders all of them.
 *
 * `lockReason` is written by the page parser to be read by a person ("value from
 * c.hotelsTitle", "item 2 of DEALS", "one branch of several — chosen in code"),
 * so it is shown verbatim rather than re-worded here.
 */
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import styles from './SharedComponentNotice.module.css'

interface SourceLockedNoticeProps {
  /** `PageNode.lockReason` — the parser's own human-readable phrase. */
  lockReason: string
  /** `PageNode.resolution.note`, when the evaluator had to choose (e.g. which locale branch). */
  note?: string
  /**
   * `PageNode.textOrigin` — where the text's string literal lives, when it has
   * one. Its presence means an edit to the text lands there instead of on the
   * JSX, so the notice can say where the user's typing will go.
   */
  textOrigin?: { rel: string; line: number; col: number }
  /** How many nodes across the site resolve their text to the SAME literal. */
  sharedWith?: number
  /** `PageNode.codeProps` — the individual props with no writable target. */
  codeProps?: string[]
  /**
   * False for a `.map` row: one piece of source JSX renders every row, so no prop
   * write here could land on this row alone.
   */
  hasWritableLocation: boolean
}

export function SourceLockedNotice({
  lockReason,
  note,
  textOrigin,
  sharedWith,
  codeProps,
  hasWritableLocation,
}: SourceLockedNoticeProps) {
  const codeValued = (codeProps ?? []).filter((name) => !name.startsWith('style:'))

  return (
    <div className={styles.notice} role="note" data-testid="source-locked-notice">
      <LockSolidIcon size={14} className={styles.icon} />
      <p className={styles.text}>
        <strong>{lockReason}</strong>
        {note ? <> {note}.</> : '.'}{' '}
        {hasWritableLocation ? (
          <>
            This element can&apos;t be moved or deleted from here, but its own values
            are editable and write straight to the source.
            {codeValued.length > 0 ? (
              <> {codeValued.length === 1 ? 'One value comes' : `${codeValued.length} values come`}{' '}
                from an expression (<strong>{codeValued.join(', ')}</strong>) and stays
                read-only — writing there would replace the code that produces it.
              </>
            ) : null}
          </>
        ) : (
          <>
            One piece of source renders every row of this list, so a change here
            would apply to all of them — the values stay read-only.
          </>
        )}
        {textOrigin ? (
          <>
            {' '}Its text comes from <strong>{textOrigin.rel}</strong> (line{' '}
            {textOrigin.line}); editing it writes there
            {sharedWith !== undefined && sharedWith > 1 ? (
              <> and changes all <strong>{sharedWith}</strong> places that use it</>
            ) : null}
            .
          </>
        ) : null}
      </p>
    </div>
  )
}
