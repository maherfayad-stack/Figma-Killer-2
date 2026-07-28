/**
 * SourceLockedNotice — states that the selected element's values come from code,
 * so this panel cannot change them.
 *
 * A Studio-imported node is source-locked when its content is not a literal
 * sitting in the JSX: a value the §7 evaluator resolved from an expression
 * (`{c.hotelsTitle}` behind a `useLanguage()` dictionary), one iteration of a
 * `.map`, one branch of a conditional, or an element behind a spread. The store
 * enforces it — `updateNodeProps`/`setNodeInlineStyles` return early on
 * `lockReason`, deliberately silently, because both are also called
 * programmatically by agents and plugins.
 *
 * Silent was the whole problem. The panel still rendered an ordinary text box
 * with the current copy in it, so the honest-looking move — click the text,
 * retype it — produced nothing at all, with no explanation anywhere on screen.
 * 42% of the nodes on a real imported board are source-locked, so this is the
 * common case, not an edge one.
 *
 * `lockReason` is written by the page parser to be read by a person
 * ("value from c.hotelsTitle", "item 2 of DEALS", "one branch of several —
 * chosen in code"), so it is shown verbatim rather than re-worded here.
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
   * one. Its presence flips this notice from "read-only" to "editable, and here
   * is where your edit lands", because that is the actual behaviour.
   */
  textOrigin?: { rel: string; line: number; col: number }
  /** How many nodes across the site resolve their text to the SAME literal. */
  sharedWith?: number
}

export function SourceLockedNotice({ lockReason, note, textOrigin, sharedWith }: SourceLockedNoticeProps) {
  return (
    <div className={styles.notice} role="note" data-testid="source-locked-notice">
      <LockSolidIcon size={14} className={styles.icon} />
      <p className={styles.text}>
        {textOrigin ? (
          <>
            Text comes from <strong>{textOrigin.rel}</strong> (line {textOrigin.line}) via{' '}
            <strong>{lockReason.replace(/^value from /, '')}</strong>. Editing it writes there
            {sharedWith !== undefined && sharedWith > 1 ? (
              <> and changes all <strong>{sharedWith}</strong> places that use it</>
            ) : null}
            . Other properties on this element are set in code.
          </>
        ) : (
          <>
            Set in code — <strong>{lockReason}</strong>. Edit the source file to change it.
          </>
        )}
        {note ? <> {note}.</> : null}
      </p>
    </div>
  )
}
