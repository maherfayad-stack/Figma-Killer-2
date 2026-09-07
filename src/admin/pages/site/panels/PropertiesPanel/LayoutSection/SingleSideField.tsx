/**
 * SingleSideField — one CSS length property, drag-scrubbable + token-aware.
 * The expanded (four-sides) half of the padding/margin
 * `ExpandableFieldCluster` idiom — see `LinkedAxisField` for the collapsed
 * (two-sides-at-once) half.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import type { Token } from '@site/property-controls/tokenUtils'
import { isMixedStyleValue, plainString, readString } from '../styleValueUtils'
import { resolveStyleFieldDisplay } from '../styleFieldDisplay'
import { ScrubTokenField } from './ScrubTokenField'

interface SingleSideFieldProps {
  ariaLabel: string
  /** Draggable, `aria-hidden` letterform — e.g. "L" / "T" / "R" / "B". */
  prefix: string
  property: keyof CSSPropertyBag
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  'data-testid'?: string
}

export function SingleSideField({
  ariaLabel,
  prefix,
  property,
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onPreview,
  onClearPreview,
  'data-testid': dataTestId,
}: SingleSideFieldProps) {
  // The one display rule (`styleFieldDisplay.ts`): the stored length, else the
  // one the element actually renders (muted), else `0px` as a hint.
  const display = resolveStyleFieldDisplay({
    storedValue: readString(storedStyles, String(property)),
    currentValue: readString(currentStyles, String(property)),
    fallback: '0px',
  })
  const mixed = isMixedStyleValue(storedStyles, currentStyles, String(property))

  return (
    <ScrubTokenField
      aria-label={ariaLabel}
      value={plainString(display.value) || undefined}
      placeholder={display.placeholder}
      inherited={display.inherited}
      mixed={mixed}
      tokens={tokens}
      prefix={prefix}
      onCommit={(resolved) => onChange(property, resolved)}
      onPreview={
        onPreview ? (resolved) => onPreview({ [property]: resolved ?? null } as Partial<CSSPropertyBag>) : undefined
      }
      onClearPreview={onClearPreview}
      data-testid={dataTestId}
    />
  )
}
