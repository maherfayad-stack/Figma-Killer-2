/**
 * LinkedSidesField — Figma's linked padding box: ONE field standing for all
 * four sides, writing them in a single patch.
 *
 * It is `LinkedAxisField` with four properties instead of two, and one
 * deliberate difference: it commits through a patch-shaped `onChangeMany`
 * rather than four `onChange` calls, so linking every side to one value is
 * one history entry rather than four. (`LinkedAxisField` still writes its two
 * sides separately; that is its own pre-existing behaviour, not something
 * this file changes.)
 *
 * The four longhands, never the `padding` shorthand. The shorthand would be a
 * different declaration with its own read-back and conflict rules — see
 * `borderRadiusShorthand.ts` for what that costs — and Figma's padding link
 * is about how many fields are drawn, not about which declaration is written.
 * Corner radius is the one control where the link genuinely picks the
 * declaration, because there the shorthand is what a human writes.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import type { Token } from '@site/property-controls/tokenUtils'
import { isMixedStyleValue, plainString, readString } from '../../../panels/PropertiesPanel/styleValueUtils'
import { resolveStyleFieldDisplay } from '../../../panels/PropertiesPanel/styleFieldDisplay'
import { ScrubTokenField } from './ScrubTokenField'

interface LinkedSidesFieldProps {
  ariaLabel: string
  /** Draggable, `aria-hidden` letterform — e.g. "A" for "all sides". */
  prefix: string
  properties: ReadonlyArray<keyof CSSPropertyBag>
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  /** One patch, one history entry. */
  onChangeMany: (patch: Record<string, string | number | null>) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  'data-testid'?: string
}

export function LinkedSidesField({
  ariaLabel,
  prefix,
  properties,
  storedStyles,
  currentStyles,
  tokens,
  onChangeMany,
  onPreview,
  onClearPreview,
  'data-testid': dataTestId,
}: LinkedSidesFieldProps) {
  // Any side disagreeing makes the linked field mixed — it writes all four at
  // once, so it cannot honestly show one side's value.
  const mixed = properties.some((prop) => isMixedStyleValue(storedStyles, currentStyles, String(prop)))

  // The one display rule (`styleFieldDisplay.ts`): the first side that
  // declares something, else the padding the element actually renders.
  const firstStored = properties.map((prop) => readString(storedStyles, String(prop))).find((v) => v != null)
  const firstCurrent = properties.map((prop) => readString(currentStyles, String(prop))).find((v) => v != null)
  const display = resolveStyleFieldDisplay({
    storedValue: firstStored,
    currentValue: firstCurrent,
    fallback: '0px',
  })

  const patchFor = (resolved: string | undefined): Record<string, string | null> =>
    Object.fromEntries(properties.map((prop) => [String(prop), resolved ?? null]))

  return (
    <ScrubTokenField
      aria-label={ariaLabel}
      value={plainString(display.value) || undefined}
      placeholder={display.placeholder}
      inherited={display.inherited}
      mixed={mixed}
      tokens={tokens}
      prefix={prefix}
      onCommit={(resolved) => onChangeMany(patchFor(resolved))}
      onPreview={onPreview ? (resolved) => onPreview(patchFor(resolved) as Partial<CSSPropertyBag>) : undefined}
      onClearPreview={onClearPreview}
      data-testid={dataTestId}
    />
  )
}
