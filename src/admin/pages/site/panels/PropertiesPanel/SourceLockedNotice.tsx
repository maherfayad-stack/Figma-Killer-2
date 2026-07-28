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
}

export function SourceLockedNotice({ lockReason, note }: SourceLockedNoticeProps) {
  return (
    <div className={styles.notice} role="note" data-testid="source-locked-notice">
      <LockSolidIcon size={14} className={styles.icon} />
      <p className={styles.text}>
        Set in code — <strong>{lockReason}</strong>. Edit the source file to change it.
        {note ? <> {note}.</> : null}
      </p>
    </div>
  )
}
