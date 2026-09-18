/**
 * GapRow — Penpot's Row gap / Column gap pair (`STATE.md` `panel-25`, P3
 * item 4).
 *
 * The old `GapInput` wrote the single `gap` shorthand. Re-checked against
 * the real fixture screenshot before rebuilding this (this work order's own
 * instruction, not a guess): `screenshots/f3-flexboard/dark/design.png`
 * shows TWO separate fields side by side — a muted/disabled row-gap field
 * reading `0`, and a live column-gap field reading `16` — matching
 * `03-operating-behaviors.md`'s own note: "On the F3 flex board (single
 * row, no wrap): the Row gap field renders [disabled] — present, visible,
 * but not editable — because it's meaningless in that configuration. Only
 * Column gap is live." This is Penpot's own Law-5 disclosure rule (`display`
 * decides which fields exist / are editable) applied to gap specifically,
 * independently confirmed by a second real product.
 *
 * Disable rule (flex only — grid has no equivalent P0 evidence, so both
 * fields stay editable there per this work order's own "don't invent
 * undecoded behavior" posture, matching `MeasuresSection`'s treatment of
 * the FLEX ELEMENT icon row): the axis PERPENDICULAR to `flexDirection` only
 * matters once the container can wrap onto a second line/column. A
 * single-row flex row (`flexDirection: row`, no wrap) can never show a
 * second row, so `rowGap` is inert; a single-column flex column
 * (`flexDirection: column`, no wrap) can never show a second column, so
 * `columnGap` is inert. The moment `flexWrap` is `wrap`/`wrap-reverse`,
 * both axes can matter, so both fields go live.
 *
 * Writes the LONGHANDS (`rowGap`/`columnGap`) directly, not the `gap`
 * shorthand — Penpot's own model edits them as two independent facts, and
 * `gap` stays claimed in `MIGRATED_SECTION_PROPERTIES` purely so a value set
 * from raw source stays out of the generic Custom Properties editor.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { GapIcon, RowGapIcon } from '@ui/components/InspectorIcons'
import { LabeledControl } from './LabeledControl'
import { ScrubTokenField } from './ScrubTokenField'
import styles from '../LayoutSection.module.css'

interface GapRowProps {
  rowGapValue: string | undefined
  rowGapIsSet: boolean
  rowGapMixed?: boolean
  columnGapValue: string | undefined
  columnGapIsSet: boolean
  columnGapMixed?: boolean
  /** Flex only — see this file's doc for the disable rule. `undefined` (grid, or no evidence) leaves both fields live. */
  rowGapDisabledReason?: string
  columnGapDisabledReason?: string
  onChangeRowGap: (value: string | undefined) => void
  onChangeColumnGap: (value: string | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function GapRow({
  rowGapValue,
  rowGapIsSet,
  rowGapMixed,
  columnGapValue,
  columnGapIsSet,
  columnGapMixed,
  rowGapDisabledReason,
  columnGapDisabledReason,
  onChangeRowGap,
  onChangeColumnGap,
  onPreview,
  onClearPreview,
}: GapRowProps) {
  const tokens = useSpacingTokens()

  return (
    <div className={styles.gapRow}>
      <LabeledControl isSet={rowGapIsSet}>
        <span title={rowGapDisabledReason}>
          <ScrubTokenField
            aria-label="Row gap"
            value={rowGapValue}
            placeholder="0px"
            mixed={rowGapMixed}
            inherited={!rowGapIsSet && rowGapValue !== undefined && rowGapValue !== ''}
            prefix={<RowGapIcon size={13} aria-hidden="true" />}
            tokens={tokens}
            min={0}
            disabled={rowGapDisabledReason != null}
            onCommit={onChangeRowGap}
            onPreview={onPreview ? (v) => onPreview({ rowGap: v ?? null } as Partial<CSSPropertyBag>) : undefined}
            onClearPreview={onClearPreview}
            data-testid="css-row-gap-input"
          />
        </span>
      </LabeledControl>
      <LabeledControl isSet={columnGapIsSet}>
        <span title={columnGapDisabledReason}>
          <ScrubTokenField
            aria-label="Column gap"
            value={columnGapValue}
            placeholder="0px"
            mixed={columnGapMixed}
            inherited={!columnGapIsSet && columnGapValue !== undefined && columnGapValue !== ''}
            prefix={<GapIcon size={13} aria-hidden="true" />}
            tokens={tokens}
            min={0}
            disabled={columnGapDisabledReason != null}
            onCommit={onChangeColumnGap}
            onPreview={onPreview ? (v) => onPreview({ columnGap: v ?? null } as Partial<CSSPropertyBag>) : undefined}
            onClearPreview={onClearPreview}
            data-testid="css-column-gap-input"
          />
        </span>
      </LabeledControl>
    </div>
  )
}
