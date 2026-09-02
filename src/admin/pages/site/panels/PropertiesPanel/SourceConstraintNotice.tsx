/**
 * SourceConstraintNotice — the ONE whole-node structural fact worth a banner,
 * plus (unrelated but sharing this slot) the one whole-node fact about where
 * a resolved TEXT literally lives.
 *
 * Track F2 / R7 (`docs/audits/2026-08-06/09-refusal-states.md`) deleted this
 * component's THIRD variant — "nothing structural at all, only values came
 * from code" — which used to render unconditionally on the MAJORITY of a
 * real imported board's nodes (149/276 on the eSIM corpus) to say something
 * `CodeValueControl` already says, per field, right next to the control it's
 * about (`propLockReason` now names each prop's own resolved source — R2).
 * A node-level paragraph repeating that fact was noise, not new information.
 *
 * What's left is exactly two honest, whole-node things:
 *
 * 1. **Structural** — the source does not PLACE this element (a ternary/`&&`
 *    chose it, a spread feeds it, a `.map` renders every row). `lockReason`
 *    is present only for this case, and is what selects it.
 * 2. **Resolved text has a known literal home** (`textOrigin`) — genuinely
 *    node-level (not a per-field fact `CodeValueControl` could show, because
 *    a node with `textOrigin` is WRITABLE: no disabled row exists to attach
 *    a per-field hint to; the control is an ordinary editable text input).
 *    Independent of the structural lock — either, both, or neither may be
 *    true of a given node.
 *
 * R8: `textOrigin`'s `file:line` is now a real jump-to-source button, not
 * plain text (`jumpToSource.ts`).
 */
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { jumpToSource } from './jumpToSource'
import styles from './SharedComponentNotice.module.css'

interface SourceConstraintNoticeProps {
  /**
   * `PageNode.lockReason` — the parser's own human-readable phrase for a
   * STRUCTURAL lock. Absent when the element's structure is ordinary source.
   */
  lockReason?: string
  /**
   * `PageNode.textOrigin` — where the text's string literal lives, when it has
   * one. Its presence means an edit to the text lands there instead of on the
   * JSX, so the notice can say where the user's typing will go.
   */
  textOrigin?: { rel: string; line: number; col: number }
  /** How many nodes across the site resolve their text to the SAME literal. */
  sharedWith?: number
  /**
   * False for a `.map` row: one piece of source JSX renders every row, so no
   * prop write here could land on this row alone.
   */
  hasWritableLocation: boolean
}

export function SourceConstraintNotice({
  lockReason,
  textOrigin,
  sharedWith,
  hasWritableLocation,
}: SourceConstraintNoticeProps) {
  const structural = lockReason !== undefined

  // Neither fact applies — say nothing. `CodeValueControl` (per prop) and
  // `InlineStyleComposer` (per style property, once F1's provenance wiring
  // lands — see `editConstraint.ts`'s `explainStyleConstraint` doc) carry
  // every other fact this component used to repeat.
  if (!structural && textOrigin === undefined) return null

  return (
    <div
      className={cn(styles.notice, structural ? undefined : styles.noticeInfo)}
      role="note"
      data-testid="source-constraint-notice"
      data-variant={structural ? (hasWritableLocation ? 'structure-locked' : 'list-row') : 'text-origin-only'}
    >
      {structural ? (
        <LockSolidIcon size={14} className={styles.icon} />
      ) : (
        <CodeIcon size={14} className={styles.icon} />
      )}
      <p className={styles.text}>
        {structural ? (
          <>
            <strong>{lockReason}</strong>.{' '}
            {hasWritableLocation ? (
              <>
                This element can&apos;t be moved or deleted from here, but its own values are
                editable and write straight to the source.
              </>
            ) : (
              <>
                One piece of source renders every row of this list, so a change here would apply to
                all of them — the values stay read-only.
              </>
            )}
          </>
        ) : null}
        {textOrigin ? (
          <>
            {' '}Its text comes from{' '}
            <Button
              variant="ghost"
              size="xs"
              className={styles.jumpToSourceButton}
              onClick={() => jumpToSource(textOrigin)}
            >
              {textOrigin.rel} (line {textOrigin.line})
              <ExternalLinkSolidIcon size={11} />
            </Button>
            ; editing it writes there
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
