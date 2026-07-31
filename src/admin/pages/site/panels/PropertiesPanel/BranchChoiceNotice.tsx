/**
 * BranchChoiceNotice — states which branch the parser picked when a component
 * had more than one JSX-bearing `return`, or a JSX child was a ternary/`&&`
 * (parser-06), and names the branch(es) it did NOT show.
 *
 * The predecessor policy rendered every branch, stacked, and locked the
 * result — honest, but a screen with four stages was four screens tall on
 * the board. The parser now SELECTS one (the last `return` — overwhelmingly
 * a component's "normal" state — or a ternary's consequent, unless the
 * evaluator can actually resolve the condition), which is why this element
 * is NOT locked: the structure at this exact location is completely
 * ordinary, only WHICH runtime state it shows by default was chosen.
 *
 * This is deliberately view-only. `PageNode.branchAlternatives` names where
 * each untaken branch lives in source (a label + `file:line`), which is
 * enough to tell a user "there is a loading state here too, and this is
 * where it lives" — actually swapping which branch renders on the canvas is
 * editor state that would need a store-level "preview branch" action this
 * pass does not add (see STATE.md's `parser-06` handoff for why, and what a
 * follow-up would need).
 */
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import type { PageNode } from '@core/page-tree'
import styles from './SharedComponentNotice.module.css'

interface BranchChoiceNoticeProps {
  /** `PageNode.branchAlternatives` — always non-empty when this notice is rendered at all. */
  alternatives: NonNullable<PageNode['branchAlternatives']>
}

export function BranchChoiceNotice({ alternatives }: BranchChoiceNoticeProps) {
  return (
    <div className={styles.notice} role="note" data-testid="branch-choice-notice">
      <BoxStackSolidIcon size={14} className={styles.icon} />
      <p className={styles.text}>
        Showing one of {alternatives.length + 1} states this element can render. Not shown:{' '}
        {alternatives.map((alt, index) => (
          <span key={`${alt.loc.file}:${alt.loc.line}:${alt.loc.col}`}>
            {index > 0 ? ', ' : ''}
            <strong>{alt.label}</strong> ({alt.loc.file}:{alt.loc.line})
          </span>
        ))}
        .
      </p>
    </div>
  )
}
