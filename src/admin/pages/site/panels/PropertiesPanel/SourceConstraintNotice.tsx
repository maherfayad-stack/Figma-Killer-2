/**
 * SourceConstraintNotice — explains what the source does to the selected
 * element, and which of its values that does or does not put out of reach.
 *
 * There are exactly three honest things to say about a Studio-imported node,
 * and the notice says one of them. The wording matters because a false
 * explanation is worse than no explanation:
 *
 * 1. **The source does not PLACE this element** and it has a location of its
 *    own — a ternary/`&&` chose it, a spread feeds it, its `<svg>` is built in
 *    code. It cannot be moved or deleted; its literal attributes are still
 *    precisely writable.
 * 2. **A `.map` row.** One piece of source JSX renders every row, so there is
 *    no isolated target for anything: structure *or* values.
 * 3. **Nothing structural at all — only values came from code.** `{c.heading}`
 *    on an ordinary `<h1>` at a known line and column. This is the majority
 *    case on a real board (149 of 276 flagged nodes on the eSIM corpus), and
 *    until `lock-01` it was shown variant 1's copy, whose first clause —
 *    "This element can't be moved or deleted from here" — is simply false for
 *    it. The parser no longer locks these (`withResolution` in
 *    `src/core/page-parser/nodeResolution.ts`), so the notice must not claim
 *    they are locked either.
 *
 * `lockReason` is written by the page parser to be read by a person ("item 2 of
 * DEALS", "spread props") and is present ONLY for a structural lock, so its
 * presence is exactly what picks variant 1/2 over variant 3. It is shown
 * verbatim rather than re-worded here.
 */
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { cn } from '@ui/cn'
import styles from './SharedComponentNotice.module.css'

interface SourceConstraintNoticeProps {
  /**
   * `PageNode.lockReason` — the parser's own human-readable phrase for a
   * STRUCTURAL lock. Absent when the element's structure is ordinary source.
   */
  lockReason?: string
  /**
   * `PageNode.resolution` — where a value on this node came from, plus the
   * `note` the evaluator recorded when it had to choose (e.g. which locale).
   */
  resolution?: { source: string; note?: string }
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
   * False for a `.map` row: one piece of source JSX renders every row, so no
   * prop write here could land on this row alone.
   */
  hasWritableLocation: boolean
}

export function SourceConstraintNotice({
  lockReason,
  resolution,
  textOrigin,
  sharedWith,
  codeProps,
  hasWritableLocation,
}: SourceConstraintNoticeProps) {
  // Inline-style entries (`style:color`) are refused per-property by the style
  // controls themselves, which say so where the user is already looking.
  // Naming them here as well is noise. A `studio.instance`'s call-site props
  // carry the `callSiteProps:` namespace `codeProps` uses to keep them distinct
  // from the node's own — the user sees them simply as that component's props,
  // and the row they read this against is labelled `title`, not
  // `callSiteProps:title`.
  const codeValued = (codeProps ?? [])
    .filter((name) => !name.startsWith('style:'))
    .map((name) => (name.startsWith('callSiteProps:') ? name.slice('callSiteProps:'.length) : name))
  const structural = lockReason !== undefined

  // Nothing structural, no read-only value, and nowhere else the user's typing
  // would land: there is nothing true worth saying, so say nothing. This is
  // also what keeps the notice off a node whose only `resolution` is the
  // BRANCH note `walkExpressionForJsx` attaches (`{ source: <the file>, note }`
  // — a structural explanation borrowing the same shape, see `ParsedNode`):
  // `BranchChoiceNotice` owns that node and says it better.
  if (!structural && codeValued.length === 0 && textOrigin === undefined) return null

  const heading = lockReason ?? (resolution ? `value from ${resolution.source}` : 'set in code')
  const readOnlyValues =
    codeValued.length > 0 ? (
      <>
        {' '}
        {codeValued.length === 1 ? 'One value comes' : `${codeValued.length} values come`} from an
        expression (<strong>{codeValued.join(', ')}</strong>) and{' '}
        {codeValued.length === 1 ? 'stays' : 'stay'} read-only — writing there would replace the
        code that produces it.
      </>
    ) : null

  return (
    <div
      className={cn(styles.notice, structural ? undefined : styles.noticeInfo)}
      role="note"
      data-testid="source-constraint-notice"
      data-variant={structural ? (hasWritableLocation ? 'structure-locked' : 'list-row') : 'values-only'}
    >
      {structural ? (
        <LockSolidIcon size={14} className={styles.icon} />
      ) : (
        <CodeIcon size={14} className={styles.icon} />
      )}
      <p className={styles.text}>
        <strong>{heading}</strong>
        {resolution?.note ? <> {resolution.note}.</> : '.'}{' '}
        {structural ? (
          hasWritableLocation ? (
            <>
              This element can&apos;t be moved or deleted from here, but its own values are editable
              and write straight to the source.
              {readOnlyValues}
            </>
          ) : (
            <>
              One piece of source renders every row of this list, so a change here would apply to
              all of them — the values stay read-only.
            </>
          )
        ) : (
          <>
            The source places this element at a known line, so it is not locked — only its value is
            code.
            {readOnlyValues}
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
