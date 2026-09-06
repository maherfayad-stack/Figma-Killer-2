/**
 * LinkedAxisField — one field that writes TWO CSS properties at once
 * (`paddingLeft` + `paddingRight` for "Horizontal", `paddingTop` +
 * `paddingBottom` for "Vertical" — same shape for `margin*`). This is the
 * collapsed half of `ExpandableFieldCluster`'s padding/margin idiom (F4's
 * `[⊓ 66] [⊐ 155]`): the cluster itself only knows "which array of fields is
 * on screen", so the "one field, two properties" behaviour lives here.
 *
 * Displayed value is whichever side has a stored value (preferring `propA`),
 * so a cluster manually kept collapsed while its two sides actually disagree
 * still shows *something* rather than blanking out — editing it re-links
 * both sides to the typed value, same as Figma's own H/V fields.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import type { Token } from '@site/property-controls/tokenUtils'
import { hasStyleValue, readString } from '../styleValueUtils'
import { ScrubTokenField } from './ScrubTokenField'

interface LinkedAxisFieldProps {
  ariaLabel: string
  /** Draggable, `aria-hidden` letterform — e.g. "H" / "V". */
  prefix: string
  propA: keyof CSSPropertyBag
  propB: keyof CSSPropertyBag
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  'data-testid'?: string
}

export function LinkedAxisField({
  ariaLabel,
  prefix,
  propA,
  propB,
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onPreview,
  onClearPreview,
  'data-testid': dataTestId,
}: LinkedAxisFieldProps) {
  const storedA = readString(storedStyles, String(propA))
  const storedB = readString(storedStyles, String(propB))
  const currentA = readString(currentStyles, String(propA))
  const currentB = readString(currentStyles, String(propB))

  const value = storedA ?? storedB
  const placeholder = currentA ?? currentB ?? '0px'
  const isSet = hasStyleValue(storedA) || hasStyleValue(storedB)

  function commit(resolved: string | undefined) {
    onChange(propA, resolved)
    onChange(propB, resolved)
  }

  function preview(resolved: string | undefined) {
    if (!onPreview) return
    onPreview({ [propA]: resolved ?? null, [propB]: resolved ?? null } as Partial<CSSPropertyBag>)
  }

  return (
    <ScrubTokenField
      aria-label={ariaLabel}
      value={value}
      placeholder={isSet ? undefined : placeholder}
      tokens={tokens}
      prefix={prefix}
      onCommit={commit}
      onPreview={onPreview ? preview : undefined}
      onClearPreview={onClearPreview}
      data-testid={dataTestId}
    />
  )
}
