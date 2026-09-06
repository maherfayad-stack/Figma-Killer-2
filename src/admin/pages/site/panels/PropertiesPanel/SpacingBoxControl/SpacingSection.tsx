/**
 * SpacingSection — the Spacing section's new shape (STUDIO-INSPECTOR-
 * DISCLOSURE-PLAN.md §4 G4).
 *
 * Padding moved into the Layout section (`LayoutSection/PaddingCluster.tsx`)
 * — it's a property of how an element lays out its OWN box, the same
 * category as display/gap/align. Margin stays here: it's a relationship with
 * SIBLINGS, not with the element's own children, and Figma draws the same
 * line (padding lives inside "Auto layout", margin doesn't exist as a
 * concept in Figma's box model at all — for us it's still real CSS, so it
 * keeps a home).
 *
 * The margin cluster (F4's `[⊓][⊐][⊞]` idiom, built on the same
 * `ExpandableFieldCluster` primitive `PaddingCluster` uses) is the new
 * default. `SpacingBoxControl` — the 4:3 box-model diagram this section used
 * to render unconditionally — SURVIVES, unconditionally: it is genuinely the
 * best control for "which side is which" on an unfamiliar element, and
 * deleting it would be a real capability loss. It moves behind a ⚙
 * (`InspectorPopover`, "Box model"), where it can be as large as it likes
 * without taxing every selection's resting height — it edits all 8
 * properties (padding AND margin) exactly as it always did, so it stays the
 * single place to see all eight sides in relation to each other regardless
 * of where their individual fields now live day to day.
 */
import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { hasStyleValue, readString } from '../styleValueUtils'
import { LinkedAxisField } from '../LayoutSection/LinkedAxisField'
import { SingleSideField } from '../LayoutSection/SingleSideField'
import { SpacingBoxControl } from './SpacingBoxControl'
import styles from './SpacingSection.module.css'

interface SpacingSectionProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

const MARGIN_SIDES: ReadonlyArray<keyof CSSPropertyBag> = [
  'marginLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
]

export function SpacingSection({
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: SpacingSectionProps) {
  const tokens = useSpacingTokens()
  const [boxModelOpen, setBoxModelOpen] = useState(false)
  const boxModelTriggerRef = useRef<HTMLButtonElement>(null)

  const values = MARGIN_SIDES.map((prop) => readString(storedStyles, String(prop)))
  const anySet = values.some((v) => hasStyleValue(v))
  // Law 4: linked purely from the data — every side equal, OR nothing set at
  // all (see `PaddingCluster`'s identical derivation and `AppearanceSection`'s
  // `radiusLinked`, which this mirrors).
  const linked = !anySet || values.every((v) => v === values[0])

  return (
    <div className={styles.spacingSection}>
      <div className={styles.marginRow}>
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
        <Button
          ref={boxModelTriggerRef}
          variant="ghost"
          size="xs"
          iconOnly
          aria-haspopup="dialog"
          aria-expanded={boxModelOpen}
          aria-label="Box model"
          tooltip="Box model — padding and margin diagram"
          data-testid="spacing-box-model-trigger"
          onClick={() => setBoxModelOpen((open) => !open)}
        >
          <SlidersHorizontalIcon size={14} aria-hidden="true" />
        </Button>
      </div>
      {boxModelOpen && (
        <InspectorPopover
          id="spacing-box-model"
          anchorRef={boxModelTriggerRef}
          onClose={() => setBoxModelOpen(false)}
          title="Box model"
          width={280}
        >
          <SpacingBoxControl
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </InspectorPopover>
      )}
    </div>
  )
}
