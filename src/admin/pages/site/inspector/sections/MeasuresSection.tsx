/**
 * MeasuresSection — Penpot's Measures section: W/H, X/Y, rotation, radius,
 * Hug/Fill, and the Constraints-vs-Flex-element identity swap (`STATE.md`
 * `panel-25`, item 3 of the P3 mapping table — `STUDIO-LIVE-CANVAS-PLAN.md`
 * §P3). Must land immediately after Layer (item 1), never separately
 * verified green in between — this is the one old file (`AppearanceSection.tsx`)
 * Layer's own PR split across two new sections, and this PR is the one that
 * deletes it outright, per Layer's own "Deletes" note.
 *
 * ## The load-bearing geometry finding
 *
 * `02-measurements.md`'s own Y-origins prove radius sits in the SAME section
 * as W/H/X/Y/rotation, not bundled with opacity/blend the way the old
 * `AppearanceSection.tsx` grouped them: `W/H row y=180` (Δ16 from Layer above
 * it — a real section-boundary gap, `--inspector-gap-group`), `X/Y row y=216`
 * (Δ4 — tightly paired, `--inspector-gap-tight`), `rotation/radius row y=252`
 * (Δ4 — ALSO tightly paired). Rotation therefore now pairs with RADIUS on one
 * row, not with the z-index settings trigger the way the old
 * `PositionSection.tsx` paired them — see "Where z-index lives" below for
 * where that trigger moved instead. The whole block is unlabeled — Penpot's
 * own screenshot (`f1-rectangle/dark/design.png`) shows no header text above
 * it, matching Layer's own template.
 *
 * ## What this claims
 *
 * `width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`,
 * `aspectRatio`, `boxSizing` (ported from `SizeSection.tsx`, reused
 * UNCHANGED — its Fixed/Hug/Fill picker already reuses `elementSizing.ts`'s
 * resolution and already disables Hug/Fill with a reason when there's no
 * real parent layout, which is the honest substance behind Penpot's FLEX
 * ELEMENT hug/fill buttons; this design does not duplicate that control into
 * a second face — see "Hug/Fill" below); `position`, `top`, `right`,
 * `bottom`, `left`, `rotate`, `scale`, `zIndex` (ported from the retired
 * `PositionSection.tsx`, restructured — see below); the 4 `border*Radius`
 * longhands (ported from the retired `AppearanceSection.tsx`, now
 * `RadiusCluster.tsx`, a sibling file in this same folder).
 *
 * ## The Constraints-vs-Flex-element identity swap
 *
 * `03-operating-behaviors.md`: a shape with no flex/grid parent shows
 * `CONSTRAINTS`; the moment it becomes a flex/grid child, `CONSTRAINTS`
 * disappears entirely and `FLEX ELEMENT` takes its place — "the section
 * itself changes identity, not just its contents," never both, never a
 * disabled/grayed placeholder for the one that doesn't apply.
 *
 * P0 evidenced exactly ONE concrete difference between the two faces: a real,
 * screenshotted `FLEX ELEMENT` uppercase header the moment the parent is
 * flex/grid (`f3-flexboard/dark/design-child.png`), which the plain-rectangle
 * screenshot (`f1-rectangle/dark/design.png`, no parent at all) does not
 * show for the equivalent content. P0 did NOT decode the exact CSS semantics
 * behind Penpot's `FLEX ELEMENT` icon row (`03-operating-behaviors.md` names
 * them only descriptively: "a Static/Absolute toggle, sizing-behavior icon
 * buttons, a z-index field") and never screenshotted a plain board's non-flex
 * child at all (`01-fixtures.md`'s own "what's deliberately not a fixture"
 * note), so there is no evidenced CONSTRAINTS header shape to build against
 * either — Studio's existing `PositionConstraints`/`ConstraintsDiagram`
 * (F29's side pickers + crosshair) already cover that honestly.
 *
 * This section therefore reproduces the ONE evidenced difference — a header
 * label — and keeps the CONTENT identical between the two faces (the
 * existing position switcher, then either the plain TRBL direction grid or
 * `PositionConstraints`, exactly as `PositionSection.tsx` already resolved
 * it): wrapped in a `forceOpen` `Section` titled "Flex element" when the
 * parent IS flex/grid (`LayoutSection/layoutMode.ts`'s existing
 * `resolveLayoutMode` check, fed the PARENT's computed `display`/
 * `flexDirection` — reused, not re-derived, per this work order's own
 * instruction), unwrapped and unlabeled otherwise. Inventing a NEW
 * Static/Absolute toggle distinct from the existing `position` switcher, or a
 * new icon-button hug/fill control distinct from `SizeSection`'s existing
 * one, would be UI that lies about a CSS distinction Studio's model doesn't
 * actually have — flagged here explicitly as a deliberate, evidenced
 * divergence, the same posture `AlignSection`'s own doc took for its
 * "hides entirely" behavior.
 *
 * ## Where z-index lives
 *
 * The old `PositionSection.tsx` paired `ZIndexSettingsRow` with rotation on
 * one row. Rotation now pairs with radius (see above), so z-index needed a
 * new seat — it moves to the position/constraints row instead, and STAYS
 * RESIDENT regardless of which face (Constraints or Flex element) is
 * showing. Penpot's own `FLEX ELEMENT` header shows a "Z --" field and the
 * plain-rectangle screenshot shows none at all, but Studio's `zIndex` is a
 * generically useful CSS escape hatch even without a flex/grid parent (e.g.
 * two absolutely-positioned siblings with no shared layout) — hiding a
 * working, testable affordance behind a fact orthogonal to what it does
 * would be a real feature loss, not a faithful port. Documented here as
 * another deliberate divergence from a literal per-fixel Penpot mirror.
 *
 * ## Hug/Fill
 *
 * Already the honest substance of Penpot's FLEX ELEMENT sizing buttons —
 * `SizeSection`'s own Fixed/Hug/Fill picker, inline under each of W/H,
 * already disables Hug/Fill (with a reason) whenever `useSizingParentLayout`
 * reports no real parent layout, and enables them the moment it does. This
 * section does not duplicate that control into a second, separate face.
 *
 * ## Locked (code-valued) properties
 *
 * Every property this section claims is filtered through
 * `selectedNode.codeProps`'s `style:<prop>` keys, ported verbatim from
 * `StyleSectionsComposer.tsx`'s own top-level check (this work order's own
 * instruction: "each new section must reproduce its OWN slice of that
 * check"). `commitApi.ts`'s own `lockedPropertySet` gate already no-ops a
 * locked write at the store boundary — this section's adapters ALSO filter
 * locked keys out of a patch before calling `commit`, so a multi-property
 * gesture (e.g. `SizeSection`'s Fill mode switch) never silently drops just
 * the locked key mid-flight inside `commitApi` without this section knowing.
 * Old field-level locking (per the old `SizeSection`/`PositionSection`) was
 * never wired for these properties before — same honest disabling every
 * other migrated section (Layer, Align) already added.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import type { IconComponent } from 'pixel-art-icons/types'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ArrowBarUpIcon } from 'pixel-art-icons/icons/arrow-bar-up'
import { ArrowBarRightIcon } from 'pixel-art-icons/icons/arrow-bar-right'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { ArrowBarLeftIcon } from 'pixel-art-icons/icons/arrow-bar-left'
import { isMixed, MIXED } from '@ui/components/MixedValue'
import { useSpacingTokens, type Token } from '@site/property-controls/tokenUtils'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import { readString, plainString } from '../../panels/PropertiesPanel/styleValueUtils'
import { resolveStyleFieldDisplay } from '../../panels/PropertiesPanel/styleFieldDisplay'
import { DropdownSwitcher } from '../../panels/PropertiesPanel/DropdownSwitcher'
import { ScrubTokenField } from '../../panels/PropertiesPanel/LayoutSection/ScrubTokenField'
import { PositionConstraints } from '../../panels/PropertiesPanel/PositionConstraints'
import { RotationRow } from '../../panels/PropertiesPanel/RotationRow'
import { ZIndexSettingsRow } from '../../panels/PropertiesPanel/ZIndexSettingsRow'
import { SizeSection } from '../../panels/PropertiesPanel/SizeSection'
import { useSizingParentLayout } from '../../panels/PropertiesPanel/useSizingParentLayout'
import { resolveLayoutMode } from '../../panels/PropertiesPanel/LayoutSection/layoutMode'
import { RadiusCluster } from './RadiusCluster'
import layoutStyles from '../../panels/PropertiesPanel/LayoutSection.module.css'
import styles from './MeasuresSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

/** Every property this section renders a control for. */
const MEASURES_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'aspectRatio',
  'boxSizing',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'rotate',
  'scale',
  'zIndex',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
]

/** Ported verbatim from the retired `PositionSection.tsx`. */
const POSITIONED_VALUES = new Set(['relative', 'absolute', 'fixed', 'sticky'])
const CONSTRAINT_VALUES = new Set(['absolute', 'fixed'])
const POSITION_OPTIONS = ['static', 'relative', 'absolute', 'fixed', 'sticky'] as const
const POSITION_PRIMARY_SEGMENTS = [
  { value: 'relative', label: 'Relative', ariaLabel: 'Position relative', tooltip: 'position: relative' },
  { value: 'absolute', label: 'Absolute', ariaLabel: 'Position absolute', tooltip: 'position: absolute' },
] as const

export function MeasuresSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const sizingParent = useSizingParentLayout()
  const spacingTokens = useSpacingTokens()

  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues } = model

  if (!selectedNodeId || !selectedNode) return null

  // Re-key on editing-context change (base / breakpoint / condition), same
  // as the old `StyleSectionsEditor`'s `key={activeTab}` on `SizeSection`/
  // `PositionSection` — so `SizeSection`'s local reveal state (min/max rows,
  // the aspect-ratio/box-sizing settings popover) and `PositionConstraints`'
  // pending-side local state reset on a tab switch instead of bleeding a
  // different context's UI state across the boundary.
  const contextKey = activeContextId ?? 'base'

  // Ported verbatim from `LayerSection.tsx`/`AlignSection.tsx`'s own
  // per-section code-lock check — this section's own slice of
  // `StyleSectionsComposer.tsx`'s top-level banner (this work order's own
  // instruction: no composer aggregates the whole bag anymore, so each
  // section reproduces its own).
  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )

  // The same collapsed-bag pair every migrated section builds from
  // (`collapsedStyleBag.ts`), scoped to Measures' own claimed properties.
  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(MEASURES_PROPERTIES, contextOnlyClassChain, inlineStyles)
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

  // -------------------------------------------------------------------------
  // Adapters — the old `StyleSectionsEditor`-shaped callback pair, mapped
  // onto `commitApi`'s `commitStyle`/`commitStyleMany`. See
  // `StyleRuleComposer.tsx`'s own `handleChange`/`handleClearProperty` for
  // the semantics this preserves: `onChange`/`onRemove` are a SINGLE-context
  // null-set; `onClearProperty`/`onClearProperties` are a CROSS-CONTEXT purge
  // (`mode: 'clear'`).
  // -------------------------------------------------------------------------

  function onChange(property: keyof CSSPropertyBag, value: string | number | undefined) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyle(property, value ?? null)
  }

  function onRemove(property: keyof CSSPropertyBag) {
    onChange(property, undefined)
  }

  function onClearProperty(property: keyof CSSPropertyBag) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyleMany({ [property]: null } as Partial<Record<keyof CSSPropertyBag, string | number | null>>, {
      mode: 'clear',
    })
  }

  function filterLocked(patch: Record<string, string | number | null | undefined>) {
    const filtered: Record<string, string | number | null> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (lockedProperties.has(key)) continue
      filtered[key] = value ?? null
    }
    return filtered
  }

  function onChangeMany(patch: Record<string, string | number | null>) {
    const filtered = filterLocked(patch)
    if (Object.keys(filtered).length === 0) return
    commit.commitStyleMany(filtered as Partial<Record<keyof CSSPropertyBag, string | number | null>>)
  }

  function onPreview(patch: Partial<CSSPropertyBag>) {
    const filtered = filterLocked(patch as Record<string, string | number | null | undefined>)
    if (Object.keys(filtered).length === 0) return
    commit.commitStyleMany(filtered as Partial<Record<keyof CSSPropertyBag, string | number | null>>, {
      preview: true,
    })
  }

  const onClearPreview = commit.clearStylePreview

  /** Per-property adapter over the patch-shaped preview channel. */
  const previewProperty = (property: keyof CSSPropertyBag, value: string | number | undefined) =>
    onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)

  // -------------------------------------------------------------------------
  // Position / X-Y block — ported from the retired `PositionSection.tsx`,
  // unchanged in content (see this file's own "Constraints-vs-Flex-element"
  // doc for why).
  // -------------------------------------------------------------------------

  const positionMixed = isMixed(currentStyles.position)
  const position = positionMixed ? undefined : readString(currentStyles, 'position')
  const positionIsActive = position != null && POSITIONED_VALUES.has(position)
  const usesConstraints = position != null && CONSTRAINT_VALUES.has(position)

  const isFlexOrGridChild =
    sizingParent.layout != null &&
    resolveLayoutMode(sizingParent.layout.display, sizingParent.layout.flexDirection) !== 'none'

  const positionBlock = (
    <div className={styles.positionBlock}>
      <DropdownSwitcher
        property="position"
        value={positionMixed ? MIXED : position}
        primarySegments={POSITION_PRIMARY_SEGMENTS}
        allOptions={POSITION_OPTIONS}
        onChange={(v) => onChange('position', v)}
        onClear={() => onClearProperty('position')}
        onPreview={(v) => onPreview({ position: v } as Partial<CSSPropertyBag>)}
        onClearPreview={onClearPreview}
      />
      {positionIsActive && !usesConstraints && (
        <div className={layoutStyles.positionDirectionsGrid}>
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
          key={contextKey}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={spacingTokens}
          onChange={onChange}
          onClear={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      )}
    </div>
  )

  // z-index stays resident on the position row regardless of which face is
  // showing — see this file's own "Where z-index lives" doc.
  const positionRow = (
    <div className={styles.positionSettingsRow}>
      {positionBlock}
      <ZIndexSettingsRow
        storedStyles={storedStyles}
        currentStyles={currentStyles}
        onChange={onChange}
        onRemove={onRemove}
        onPreview={previewProperty}
        onClearPreview={onClearPreview}
      />
    </div>
  )

  return (
    <div className={styles.measures} data-testid="inspector-measures-section">
      <SizeSection
        key={contextKey}
        currentStyles={currentStyles}
        storedStyles={storedStyles}
        activeTab={contextKey}
        onChange={onChange}
        onChangeMany={onChangeMany}
        onRemove={onRemove}
        onClearProperty={onClearProperty}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
        parentLayout={sizingParent.layout}
        parentLayoutReason={sizingParent.reason}
      />
      {isFlexOrGridChild ? (
        <Section title="Flex element" forceOpen flush>
          <div className={styles.flexElementBody}>{positionRow}</div>
        </Section>
      ) : (
        positionRow
      )}
      <div className={styles.rotationRadiusRow}>
        <div className={styles.rotationCellWrap}>
          <RotationRow
            key={contextKey}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChange={onChange}
            onClearProperty={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
        </div>
        <div className={styles.radiusCellWrap}>
          <RadiusCluster
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChange={onChange}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DirectionInput — ported verbatim from the retired `PositionSection.tsx`.
// ---------------------------------------------------------------------------

interface DirectionInputProps {
  property: keyof CSSPropertyBag
  icon: IconComponent
  ariaLabel: string
  storedValue: unknown
  currentValue: unknown
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
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
  const display = resolveStyleFieldDisplay({
    storedValue,
    currentValue,
    fallback: 'auto',
  })
  const mixed = isMixed(display.value)
  const isSet = display.isSet

  return (
    <div
      className={layoutStyles.directionCell}
      data-state={isSet ? 'set' : 'unset'}
      data-testid={`css-direction-input-${String(property)}`}
    >
      <ScrubTokenField
        aria-label={ariaLabel}
        value={plainString(display.value) || undefined}
        placeholder={display.placeholder}
        mixed={mixed}
        inherited={display.inherited}
        prefix={<DirectionIcon size={14} />}
        tokens={tokens}
        onCommit={(resolved) => onChange(property, resolved)}
        onPreview={onPreview ? (resolved) => onPreview(property, resolved) : undefined}
        onClearPreview={onClearPreview}
        className={layoutStyles.directionInput}
        data-testid={`css-direction-${String(property)}`}
      />
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label={`Clear ${ariaLabel}`}
          tooltip={`Clear ${ariaLabel.toLowerCase()}`}
          onClick={() => onClear(property)}
          className={layoutStyles.directionClearBtn}
        >
          <CloseIcon size={12} color="currentColor" />
        </Button>
      )}
    </div>
  )
}
