/**
 * PositionSection — visual editor for the `position` CSS section.
 *
 * G10 (docs/features/inspector-disclosure.md) — Figma's F1/F2/F29 shape,
 * tightened to three rows (WS-6 §6 — this section was running at roughly
 * double its row budget):
 *
 *   Row 1 — AlignBar        the 7-button align/distribute/tidy row (F1, F2),
 *                           mounted here for the single selected node. Align
 *                           writes either the node's own `alignSelf`/
 *                           `justifySelf` or, when this is the parent's only
 *                           child, the PARENT's `justifyContent` as an inline
 *                           style (never a shared class — no blast radius).
 *                           Every edge with no single honest CSS write
 *                           renders disabled with the reason as its tooltip
 *                           — see `resolveAlignWrite`.
 *   Row 2 — PositionSwitcher  connected `[Relative | Absolute | ▼]` segmented
 *                           control with a dropdown trail. `fixed | sticky |
 *                           static` (and any custom value) render as a
 *                           SYNTHETIC trailing segment in that SAME track
 *                           rather than swapping to a different, full-width
 *                           chip shape — see `DropdownSwitcher`'s doc for why
 *                           the old two-shape design is gone. Mirrors
 *                           DisplaySwitcher's now-unified shape exactly (they
 *                           share the one `DropdownSwitcher` component).
 *   Row 2b (conditional) — DirectionInput / ConstraintAxisField  offsets,
 *                           only rendered once `position` actually honors
 *                           them (never for `static`), so a plain block
 *                           element pays nothing for this row. DirectionInput
 *                           is the plain TRBL grid used for `relative`/
 *                           `sticky` (no "constraints" metaphor — F29 is
 *                           absolute-only per Law 5). ConstraintAxisField is
 *                           F29's `absolute`/`fixed` shape: an X row and a Y
 *                           row, each a `Left ▾`/`Right ▾` (or `Top ▾`/
 *                           `Bottom ▾`) side picker plus one value field.
 *                           Switching the side MOVES the value (clears the
 *                           old property, writes the new one) rather than
 *                           leaving both set.
 *   Row 3 — RotationRow + ZIndexSettingsRow, PAIRED onto one row (F1's third
 *                           row pairs rotation with flip; flip is skipped —
 *                           see `RotationRow`'s doc — so the z-index settings
 *                           trigger takes that seat instead of sitting alone
 *                           on its own row). Rotation reads/writes the
 *                           STANDALONE `rotate` CSS property, never
 *                           `transform` — both the publisher and the canvas
 *                           emit any syntactically valid property name via
 *                           the same permissive `isEmittableProperty` gate
 *                           (`classCss.ts`), so `rotate` needs no allowlist
 *                           entry, and `rotate` composes with an existing
 *                           `transform` instead of being one of its
 *                           functions — nothing to parse, nothing to clobber.
 *                           The one case this can't stay honest for:
 *                           `transform` ALREADY contains a `rotate()`/
 *                           `rotateX/Y/Z()`/`rotate3d()` function. Two
 *                           independent rotations would both apply and
 *                           silently compound, so that case refuses the
 *                           field and falls back to a raw `transform` row
 *                           with a reason — same standing rule the plan
 *                           applies to gradients (§4 G6.3) and box-shadow
 *                           (§4 G8.3). zIndex itself stays behind its own
 *                           small sliders-icon trigger (Law 2) — see
 *                           `ZIndexSettingsRow`.
 *
 * Reuses chip / track styles from LayoutSection.module.css so the visual
 * vocabulary stays in one place — `displayRow`, etc. New, section-specific
 * styles (align row spacing, constraint cells, the rotation+settings row)
 * live in this component's own `PositionSection.module.css` rather than
 * growing LayoutSection's.
 *
 * `SingleNodeAlignRow`, `PositionConstraints` (+ `ConstraintAxisField`),
 * `RotationRow`, and `ZIndexSettingsRow` live in their own sibling files —
 * split out purely to keep this module under the repo's line-count ceiling
 * (`module-size-budgets.test.ts`); still this file's exclusive territory.
 */

import type { IconComponent } from 'pixel-art-icons/types'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ArrowBarUpIcon } from 'pixel-art-icons/icons/arrow-bar-up'
import { ArrowBarRightIcon } from 'pixel-art-icons/icons/arrow-bar-right'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { ArrowBarLeftIcon } from 'pixel-art-icons/icons/arrow-bar-left'
import { DropdownSwitcher } from './DropdownSwitcher'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens, type Token } from '@site/property-controls/tokenUtils'
import { hasStyleValue, readString } from './styleValueUtils'
import { SingleNodeAlignRow } from './SingleNodeAlignRow'
import { PositionConstraints } from './PositionConstraints'
import { RotationRow } from './RotationRow'
import { ZIndexSettingsRow } from './ZIndexSettingsRow'
import styles from './LayoutSection.module.css'
import posStyles from './PositionSection.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface PositionSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — used to key sub-controls so they re-mount on tab change. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /** Fully clear a property — see StyleRuleComposer.handleClearProperty. */
  onClearProperty: (property: keyof CSSPropertyBag) => void
  /**
   * Patch-shaped hover-preview channel (see StyleRuleComposer.handlePreview).
   * Forwarded to the position dropdown, the offset token inputs, and the
   * z-index row so hovering a suggestion previews on the canvas.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

/** Position values that honor top/right/bottom/left and reveal the
 *  directions block. `static` is intentionally excluded because static
 *  elements ignore those offsets. */
const POSITIONED_VALUES = new Set(['relative', 'absolute', 'fixed', 'sticky'])

/** Position values that get F29's constraint-side pickers instead of the
 *  plain TRBL grid. `relative`/`sticky` offsets have no "which side anchors
 *  me" metaphor — an element can't be un-anchored from its own flow
 *  position — so they keep the classic four-cell grid. */
const CONSTRAINT_VALUES = new Set(['absolute', 'fixed'])

// ---------------------------------------------------------------------------
// PositionSection
// ---------------------------------------------------------------------------

export function PositionSection({
  currentStyles,
  storedStyles,
  activeTab,
  onChange,
  onRemove,
  onClearProperty,
  onPreview,
  onClearPreview,
}: PositionSectionProps) {
  const position = readString(currentStyles, 'position')
  const positionIsActive = position != null && POSITIONED_VALUES.has(position)
  const usesConstraints = position != null && CONSTRAINT_VALUES.has(position)

  // Per-property adapter over the patch-shaped preview channel, used by the
  // offset token inputs and the z-index row (each owns a single property).
  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  // Spacing tokens drive the autocomplete dropdown on each offset input —
  // same vocabulary the SpacingBoxControl side inputs use, surfaced via
  // the shared TokenAwareInput primitive.
  const spacingTokens = useSpacingTokens()

  return (
    <>
      <SingleNodeAlignRow onChange={onChange} />
      <DropdownSwitcher
        property="position"
        value={position}
        primarySegments={POSITION_PRIMARY_SEGMENTS}
        allOptions={POSITION_OPTIONS}
        onChange={(v) => onChange('position', v)}
        onClear={() => onClearProperty('position')}
        onPreview={onPreview ? (v) => onPreview({ position: v } as Partial<CSSPropertyBag>) : undefined}
        onClearPreview={onClearPreview}
      />
      {positionIsActive && !usesConstraints && (
        <div className={styles.positionDirectionsGrid}>
          <DirectionInput
            property="top"
            icon={ArrowBarUpIcon}
            ariaLabel="Top offset"
            storedValue={storedStyles.top}
            currentValue={currentStyles.top}
            tokens={spacingTokens}
            onChange={onChange}
            onClear={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
          <DirectionInput
            property="right"
            icon={ArrowBarRightIcon}
            ariaLabel="Right offset"
            storedValue={storedStyles.right}
            currentValue={currentStyles.right}
            tokens={spacingTokens}
            onChange={onChange}
            onClear={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
          <DirectionInput
            property="bottom"
            icon={ArrowBarDownIcon}
            ariaLabel="Bottom offset"
            storedValue={storedStyles.bottom}
            currentValue={currentStyles.bottom}
            tokens={spacingTokens}
            onChange={onChange}
            onClear={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
          <DirectionInput
            property="left"
            icon={ArrowBarLeftIcon}
            ariaLabel="Left offset"
            storedValue={storedStyles.left}
            currentValue={currentStyles.left}
            tokens={spacingTokens}
            onChange={onChange}
            onClear={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
        </div>
      )}
      {usesConstraints && (
        <PositionConstraints
          key={activeTab}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={spacingTokens}
          onChange={onChange}
          onClear={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      )}
      {/* F1's third row — rotation paired with the z-index settings trigger
          rather than either sitting alone on its own row (flip is skipped,
          see the module doc, so rotation has no other companion control to
          share a row with). */}
      <div className={posStyles.rotationSettingsRow}>
        <RotationRow
          key={`${activeTab}-rotation`}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          onChange={onChange}
          onClearProperty={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
        <ZIndexSettingsRow
          key={`${activeTab}-zIndex`}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Position switcher config — Relative | Absolute + dropdown of every value
// ---------------------------------------------------------------------------

const POSITION_OPTIONS = ['static', 'relative', 'absolute', 'fixed', 'sticky'] as const

const POSITION_PRIMARY_SEGMENTS = [
  {
    value: 'relative',
    label: 'Relative',
    ariaLabel: 'Position relative',
    tooltip: 'position: relative',
  },
  {
    value: 'absolute',
    label: 'Absolute',
    ariaLabel: 'Position absolute',
    tooltip: 'position: absolute',
  },
] as const

// ---------------------------------------------------------------------------
// DirectionInput — icon-as-label numeric/text input for top/right/bottom/left
// ---------------------------------------------------------------------------

interface DirectionInputProps {
  property: keyof CSSPropertyBag
  icon: IconComponent
  ariaLabel: string
  storedValue: unknown
  currentValue: unknown
  /** Spacing tokens to suggest in the autocomplete dropdown. */
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  /** Per-property hover / as-you-type preview adapter. */
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function DirectionInput({
  property,
  icon: DirectionIcon,
  ariaLabel,
  storedValue,
  currentValue,
  tokens,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: DirectionInputProps) {
  const isSet = hasStyleValue(storedValue)
  const placeholder = !isSet
    ? hasStyleValue(currentValue)
      ? String(currentValue)
      : 'auto'
    : undefined

  return (
    <div
      className={styles.directionCell}
      data-state={isSet ? 'set' : 'unset'}
      data-testid={`css-direction-input-${String(property)}`}
    >
      <span className={styles.directionIcon} aria-hidden="true">
        <DirectionIcon size={14} />
      </span>
      <TokenAwareInput
        aria-label={ariaLabel}
        value={isSet ? String(storedValue) : undefined}
        placeholder={placeholder}
        tokens={tokens}
        onCommit={(resolved) => onChange(property, resolved)}
        onPreview={onPreview ? (resolved) => onPreview(property, resolved) : undefined}
        onClearPreview={onClearPreview}
        className={styles.directionInput}
      />
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label={`Clear ${ariaLabel}`}
          tooltip={`Clear ${ariaLabel.toLowerCase()}`}
          onClick={() => onClear(property)}
          className={styles.directionClearBtn}
        >
          <CloseIcon size={12} color="currentColor" />
        </Button>
      )}
    </div>
  )
}
