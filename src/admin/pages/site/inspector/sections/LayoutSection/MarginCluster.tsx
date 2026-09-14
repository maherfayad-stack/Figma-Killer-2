/**
 * MarginCluster — margin's new home inside the Penpot Layout section
 * (`STATE.md` `panel-25`, P3 item 4).
 *
 * Penpot has no CSS-margin concept at all (its shapes are absolutely
 * positioned; nothing in `01-fixtures.md`/`02-measurements.md`/screenshots
 * resembles a margin control) — this design folds margin into Layout,
 * directly below the padding cluster it already visually neighbored in the
 * old `LayoutSection.tsx`/`classStyleSections.ts` ("Padding lives in the
 * Layout cluster now... Margin stays in Spacing... a relationship with
 * siblings") rather than exiling it to the Studio-extras bucket (item 11):
 * same box-model mental model, smaller cognitive jump than hunting for it
 * in extras.
 *
 * Ported from the retired `SpacingBoxControl/SpacingSection.tsx`'s margin
 * block, renamed to sit alongside `PaddingCluster` (same shape, same
 * `ExpandableFieldCluster` primitive, distinct sticky expand/collapse `id`
 * — margin and padding must never share expand state, ported unchanged).
 */
import { hasStyleValue, readString } from '../../../panels/PropertiesPanel/styleValueUtils'
import type { CSSPropertyBag } from '@core/page-tree'
import type { Token } from '@site/property-controls/tokenUtils'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { LinkedAxisField } from './LinkedAxisField'
import { SingleSideField } from './SingleSideField'

interface MarginClusterProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

const SIDES: ReadonlyArray<keyof CSSPropertyBag> = ['marginLeft', 'marginTop', 'marginRight', 'marginBottom']

export function MarginCluster({
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onPreview,
  onClearPreview,
}: MarginClusterProps) {
  const values = SIDES.map((prop) => readString(storedStyles, String(prop)))
  const anySet = values.some((v) => hasStyleValue(v))
  // Law 4: linked purely from the data — every side equal, OR nothing set at
  // all (see `PaddingCluster`/`RadiusCluster`'s identical derivation).
  const linked = !anySet || values.every((v) => v === values[0])

  return (
    <ExpandableFieldCluster
      id="margin"
      linked={linked}
      expandLabel="Expand to individual margin sides"
      collapseLabel="Collapse to horizontal and vertical margin"
      collapsed={[
        <LinkedAxisField
          key="horizontal"
          ariaLabel="Margin horizontal"
          prefix="H"
          propA="marginLeft"
          propB="marginRight"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-margin-horizontal"
        />,
        <LinkedAxisField
          key="vertical"
          ariaLabel="Margin vertical"
          prefix="V"
          propA="marginTop"
          propB="marginBottom"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-margin-vertical"
        />,
      ]}
      expanded={[
        <SingleSideField
          key="left"
          ariaLabel="Margin left"
          prefix="L"
          property="marginLeft"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-margin-left"
        />,
        <SingleSideField
          key="top"
          ariaLabel="Margin top"
          prefix="T"
          property="marginTop"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-margin-top"
        />,
        <SingleSideField
          key="right"
          ariaLabel="Margin right"
          prefix="R"
          property="marginRight"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-margin-right"
        />,
        <SingleSideField
          key="bottom"
          ariaLabel="Margin bottom"
          prefix="B"
          property="marginBottom"
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          data-testid="css-margin-bottom"
        />,
      ]}
    />
  )
}
