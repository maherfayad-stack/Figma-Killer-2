/**
 * ClassCssLockedNotice — states, at the top of the class block and BEFORE the
 * user types anything, that declarations typed into this class cannot reach
 * disk, and offers the one target that can.
 *
 * ## The affordance is the point
 *
 * `StyleTargetChip`'s tooltip and `styleRuleWriteback.ts`'s post-save toast
 * both already end with the words "style the element instead". Neither of
 * them offered a way to do it: the user had to know that the Element chip
 * exists, that it is a separate write target, and that toggling it is the
 * remedy the message meant. A recommendation with no button is a rebuke.
 *
 * `onStyleElement` is the SAME `setInlineStyleEditing(true)` the Element chip
 * and `LockedStylePreview`'s "Style inline" button call — one behaviour, three
 * entry points, no fourth code path. It is omitted (and the button is not
 * rendered) when the Element target is genuinely unreachable for this node —
 * a `pkg.*`/`alm.*`/`studio.instance` module whose `style=""` is written by
 * its own source, or a source-locked node. Offering a remedy that also
 * refuses would be the same lie one level down.
 */
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { Button } from '@ui/components/Button'
import styles from './ClassCssLockedNotice.module.css'

interface ClassCssLockedNoticeProps {
  /** The selector this lock is about, e.g. `.card` — named so a multi-class node is unambiguous. */
  selector: string
  /** Why an edit can't be written — `classCssWriteLockReason`, never re-derived here. */
  reason: string
  /** Switches the panel to inline-style editing. Omitted when that target is unreachable too. */
  onStyleElement?: () => void
}

export function ClassCssLockedNotice({ selector, reason, onStyleElement }: ClassCssLockedNoticeProps) {
  return (
    <div className={styles.notice} role="note" data-testid="class-css-locked-notice">
      <LockSolidIcon size={14} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.text}>
          <strong>{selector}</strong> is read-only here. {reason} Edits below are shown for
          reference and are not saved.
        </p>
        {onStyleElement && (
          <Button
            variant="secondary"
            size="xs"
            onClick={onStyleElement}
            className={styles.action}
            tooltip="Style just this element with an inline style attribute — that layer does write back to source"
          >
            Style the element instead
          </Button>
        )}
      </div>
    </div>
  )
}
