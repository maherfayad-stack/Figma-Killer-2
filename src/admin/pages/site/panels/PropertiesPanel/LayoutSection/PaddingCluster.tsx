/**
 * PaddingCluster — F4/F9's `[⊓ 66] [⊐ 155] [⊞]` → four sides, built on
 * `ExpandableFieldCluster`.
 *
 * Padding moves into the Layout section (STUDIO-INSPECTOR-DISCLOSURE-PLAN.md
 * §4 G4.2): padding is a layout property of a container, margin is a
 * relationship with siblings, and Figma draws the line the same place.
 *
 * Rendered unconditionally — regardless of `display` — even though Figma's
 * own F3 screenshot (no auto-layout) omits it. That omission is a Figma
 * engine fact, not a CSS one: Figma's "padding" only exists once Auto Layout
 * is turned on, but CSS padding applies to every box regardless of its
 * `display`. Hiding it for a plain block element would be a real capability
 * loss (the padding UI that used to live in the Spacing section, for every
 * element, unconditionally), which contradicts this plan's own stated goal
 * ("without removing a single capability" — plan intro) — see this
 * component's test file and the G3+G4 handoff note for the full reasoning.
 *
 * `linked` — the cluster's own "are all four sides equal" flag — is derived
 * here from the four stored values, never duplicated by the cluster itself.
 */
import { hasStyleValue, readString } from '../styleValueUtils'
import type { CSSPropertyBag } from '@core/page-tree'
import type { Token } from '@site/property-controls/tokenUtils'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { LinkedAxisField } from './LinkedAxisField'
import { SingleSideField } from './SingleSideField'

interface PaddingClusterProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

const SIDES: ReadonlyArray<keyof CSSPropertyBag> = [
  'paddingLeft',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
]

export function PaddingCluster({
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onPreview,
  onClearPreview,
}: PaddingClusterProps) {
  const values = SIDES.map((prop) => readString(storedStyles, String(prop)))
  const anySet = values.some((v) => hasStyleValue(v))
  // Law 4: linked purely from the data — every side equal, OR nothing set at
  // all (a fresh element with no padding shouldn't default to four resident
  // fields — see `AppearanceSection`'s identical `radiusLinked` derivation).
  const linked = !anySet || values.every((v) => v === values[0])

  return (
    <ExpandableFieldCluster
      id="padding"
      linked={linked}
      expandLabel="Expand to individual padding sides"
      collapseLabel="Collapse to horizontal and vertical padding"
      collapsed={[
        <LinkedAxisField
          key="horizontal"
          ariaLabel="Padding horizontal"
          prefix="H"
          propA="paddingLeft"
          propB="paddingRight"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-padding-horizontal"
        />,
        <LinkedAxisField
          key="vertical"
          ariaLabel="Padding vertical"
          prefix="V"
          propA="paddingTop"
          propB="paddingBottom"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-padding-vertical"
        />,
      ]}
      expanded={[
        <SingleSideField
          key="left"
          ariaLabel="Padding left"
          prefix="L"
          property="paddingLeft"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-padding-left"
        />,
        <SingleSideField
          key="top"
          ariaLabel="Padding top"
          prefix="T"
          property="paddingTop"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-padding-top"
        />,
        <SingleSideField
          key="right"
          ariaLabel="Padding right"
          prefix="R"
          property="paddingRight"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-padding-right"
        />,
        <SingleSideField
          key="bottom"
          ariaLabel="Padding bottom"
          prefix="B"
          property="paddingBottom"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-padding-bottom"
        />,
      ]}
    />
  )
}
