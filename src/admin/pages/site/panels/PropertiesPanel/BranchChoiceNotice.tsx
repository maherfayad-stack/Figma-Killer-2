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
 * **Track F2 / R6 — the switcher, scoped honestly.** The audit's own
 * conclusion (`docs/audits/2026-08-06/09-refusal-states.md` finding R6)
 * still holds: actually swapping which branch RENDERS ON THE CANVAS needs a
 * store-level "preview branch" slot AND a parser re-run that selects branch N
 * instead of the default — an L-effort change spanning parser, store, and
 * canvas (three tracks this one does not own; per the parity plan, D2 owns
 * canvas/store seams, not this file). What this component now does, that it
 * did not before: each alternative is a real, focusable, expandable row —
 * "switcher" in the sense of choosing WHICH alternative you're reading about
 * — with a genuine jump-to-source action (R8), rather than a flat sentence.
 * `expandedIndex` is **local component state, never written to the editor
 * store and never persisted** — exactly the "editor state only, never
 * written back" instruction this track was given; it answers "which
 * alternative is the user currently looking at", nothing about the document.
 */
import { useState } from 'react'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import type { PageNode } from '@core/page-tree'
import { jumpToSource } from './jumpToSource'
import styles from './BranchChoiceNotice.module.css'
import sharedStyles from './SharedComponentNotice.module.css'

interface BranchChoiceNoticeProps {
  /** `PageNode.branchAlternatives` — always non-empty when this notice is rendered at all. */
  alternatives: NonNullable<PageNode['branchAlternatives']>
}

export function BranchChoiceNotice({ alternatives }: BranchChoiceNoticeProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  return (
    <div className={sharedStyles.notice} role="note" data-testid="branch-choice-notice">
      <BoxStackSolidIcon size={14} className={sharedStyles.icon} />
      <div className={styles.body}>
        <p className={sharedStyles.text}>
          Showing one of {alternatives.length + 1} states this element can render.{' '}
          {alternatives.length === 1 ? 'Not shown:' : `${alternatives.length} not shown:`}
        </p>
        <ul className={styles.list}>
          {alternatives.map((alt, index) => {
            const key = `${alt.loc.file}:${alt.loc.line}:${alt.loc.col}`
            const expanded = expandedIndex === index
            return (
              <li key={key}>
                <Button
                  variant="ghost"
                  size="xs"
                  align="between"
                  fullWidth
                  className={styles.altButton}
                  aria-expanded={expanded}
                  onClick={() => setExpandedIndex(expanded ? null : index)}
                >
                  <span className={styles.altLabel}>{alt.label}</span>
                  <ChevronRightIcon size={10} className={cn(styles.chevron, expanded && styles.chevronExpanded)} />
                </Button>
                {expanded ? (
                  <div className={styles.altDetail}>
                    <Button
                      variant="ghost"
                      size="xs"
                      className={styles.jumpButton}
                      onClick={() => jumpToSource({ rel: alt.loc.file, line: alt.loc.line, col: alt.loc.col })}
                    >
                      Open {alt.loc.file} (line {alt.loc.line})
                      <ExternalLinkSolidIcon size={11} />
                    </Button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
