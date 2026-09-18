/**
 * LayoutSection — Penpot's LAYOUT section: the flex/grid CONTAINER's own
 * settings (`STATE.md` `panel-25`, item 4 of the P3 mapping table —
 * `STUDIO-LIVE-CANVAS-PLAN.md` §P3).
 *
 * ## What P0 actually showed
 *
 * `screenshots/f3-flexboard/dark/design.png` (the board itself selected, a
 * flex container with two children): a real uppercase "LAYOUT" header
 * (chevron + title + trailing ⋮ + trailing −), then two rows of icon
 * toggles (wrap/direction, then align/justify — `LayoutModeRow` +
 * `FlexFlowControl` + `AlignGrid`), then a gap row, then a padding row, THEN a separate
 * "FLEX BOARD" header with an undecoded icon-only row (P0 never captured
 * what those four icons write — same evidence gap `MeasuresSection.tsx`'s
 * own doc flags for the FLEX ELEMENT icon row, and the same posture is
 * taken here: not invented). `screenshots/f1-rectangle/dark/design.png`
 * (a bare rectangle, no layout at all) shows "LAYOUT" collapsed to the
 * Title-plus-trailing-`+` convention every other empty section uses.
 *
 * ## One row until a layout exists — a disclosure, not a deletion (panel-39)
 *
 * This section used to render `forceOpen` unconditionally, on the argument
 * that `overflow`, padding, margin and the item-level `flex`/`gridColumn`/
 * `gridRow` are real, working CSS on ANY element, so hiding them behind
 * Penpot's empty-"+" gesture would be a capability loss. The measurement
 * that followed (`docs/audits/penpot-inspector-baseline/05-section-heights.
 * md`) priced that argument: **199px on every selection with no layout at
 * all**, 167px of which is body for controls nobody on a plain block had
 * asked for — the single largest line item in the Design tab's overflow of
 * the 900px budget, on three of the four baseline fixtures.
 *
 * The argument was right about the capability and wrong about the
 * mechanism. `Section`'s `empty` prop would indeed delete the body; a
 * COLLAPSED `Section` does not. So the rule is now:
 *
 *   - `display` is flex/grid (or set to a keyword the mode buttons cannot
 *     represent, or Mixed) → `forceOpen`, exactly as before. Nothing about a
 *     laid-out container changed.
 *   - otherwise → a collapsible `Section`, closed at rest: ONE 32px row,
 *     with a trailing `+` that turns on vertical auto layout (Figma's own
 *     gesture for this row) and a chevron that discloses the full body —
 *     mode row, padding, margin, clip content, settings — unchanged, in one
 *     click. Nothing is removed and nothing moved; `indicator` lights when
 *     any property this section claims is actually set, so a collapsed
 *     header never hides a value silently.
 *
 * The header's trailing "remove layout" (−) button stays the one piece of
 * Penpot's populated-state chrome this section keeps — the ⋮ settings menu
 * and the separate "FLEX BOARD" sub-header are still skipped because P0
 * never decoded what they write, matching `MeasuresSection`'s own posture
 * of not inventing undecoded icon behavior.
 *
 * ## The container/element line
 *
 * This section owns ONLY the flex/grid CONTAINER's own settings — direction,
 * wrap, align/justify, gap, grid tracks, padding, margin, overflow. The
 * per-child face (`alignSelf`/`justifySelf`) moved to `AlignSection.tsx`
 * (item 2); the per-child sizing face (hug/fill/z-index) moved to
 * `MeasuresSection.tsx`'s "Flex element" face (item 3) — neither is
 * duplicated here. `flex`/`gridColumn`/`gridRow` stay here (reached via the
 * resident `LayoutSettingsButton`) because they have no other Penpot-named
 * home and this mapping table's own claim list names them for this section.
 *
 * ## Row gap / Column gap — a real, evidenced split from the old shorthand field
 *
 * See `GapRow.tsx`'s own doc: the old single `gap`-shorthand `GapInput` is
 * replaced by two fields writing `rowGap`/`columnGap` directly, with the
 * axis perpendicular to `flexDirection` disabled when the container can
 * never show a second line (matching `03-operating-behaviors.md`'s own
 * measured Penpot behavior on the F3 fixture).
 *
 * ## Margin folds in here, directly below padding
 *
 * Penpot has no CSS-margin concept at all — see the P3 mapping table's own
 * "Margin's fate" note. `MarginCluster.tsx` (ported from the retired
 * `SpacingBoxControl/SpacingSection.tsx`) sits directly below
 * `PaddingCluster`, and the "Box model" 4:3 diagram popover (editing all 8
 * padding+margin properties at once) is ported alongside it, unchanged.
 *
 * ## Locked (code-valued) properties
 *
 * Every property this section claims is filtered through
 * `selectedNode.codeProps`'s `style:<prop>` keys, the same per-section slice
 * `LayerSection`/`AlignSection`/`MeasuresSection` already established.
 */
import { styleValueKey, type CSSPropertyBag } from '@core/page-tree'
import { Section } from '@ui/components/Section'
import { Button } from '@ui/components/Button'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { AlignGrid } from '@ui/components/AlignGrid'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { isMixed, MIXED } from '@ui/components/MixedValue'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import { hasStyleValue, readString, isMixedStyleValue } from '../../panels/PropertiesPanel/styleValueUtils'
import { useState, useRef } from 'react'
import { LayoutModeRow } from './LayoutSection/LayoutModeRow'
import {
  isLayoutModeRepresentable,
  layoutModePatch,
  resolveLayoutMode,
  type LayoutMode,
} from './LayoutSection/layoutMode'
import { FlexFlowControl } from './LayoutSection/FlexFlowControl'
import { GapRow } from './LayoutSection/GapRow'
import { GridTrackControl } from './LayoutSection/GridTrackControl'
import { LayoutSettingsButton } from './LayoutSection/LayoutSettingsButton'
import { PaddingCluster } from './LayoutSection/PaddingCluster'
import { MarginCluster } from './LayoutSection/MarginCluster'
import { SpacingBoxControl } from './LayoutSection/SpacingBoxControl'
import { ClipContentRow } from './LayoutSection/ClipContentRow'
import styles from './LayoutSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

/** Every property this section renders a control for or claims for search/curated-property bookkeeping. */
const LAYOUT_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'display',
  'flexDirection',
  'flexWrap',
  'alignItems',
  'justifyContent',
  'justifyItems',
  'flex',
  'gap',
  'rowGap',
  'columnGap',
  'gridTemplateColumns',
  'gridTemplateRows',
  'gridColumn',
  'gridRow',
  'overflow',
  'overflowX',
  'overflowY',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
]

export function LayoutSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const spacingTokens = useSpacingTokens()
  const [boxModelOpen, setBoxModelOpen] = useState(false)
  const boxModelTriggerRef = useRef<HTMLButtonElement>(null)

  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues } = model

  if (!selectedNodeId || !selectedNode) return null

  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )

  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(LAYOUT_PROPERTIES, contextOnlyClassChain, inlineStyles)
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

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

  function onClearProperties(properties: ReadonlyArray<keyof CSSPropertyBag>) {
    commit.commitStyleMany(
      Object.fromEntries(properties.filter((p) => !lockedProperties.has(String(p))).map((p) => [p, null])),
      { mode: 'clear' },
    )
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

  const display = readString(currentStyles, 'display')
  const flexDirection = readString(currentStyles, 'flexDirection') ?? 'row'
  const flexWrap = readString(currentStyles, 'flexWrap')
  const alignItems = readString(currentStyles, 'alignItems')
  const justifyContent = readString(currentStyles, 'justifyContent')
  const justifyItems = readString(currentStyles, 'justifyItems')

  const displayMixed = isMixed(currentStyles.display)
  const layoutMode: LayoutMode | typeof MIXED | undefined = displayMixed
    ? MIXED
    : isLayoutModeRepresentable(display)
      ? resolveLayoutMode(display, flexDirection)
      : undefined

  const applyLayoutMode = (mode: LayoutMode) => {
    const patch = layoutModePatch(mode)
    if (Object.keys(patch.set).length > 0) {
      onChangeMany(Object.fromEntries(Object.entries(patch.set).map(([property, value]) => [property, value ?? null])))
    }
    if (patch.clear.length > 0) onClearProperties(patch.clear)
  }

  const isFlex = layoutMode === 'vertical' || layoutMode === 'horizontal'
  const isGrid = layoutMode === 'grid'

  // Row gap / column gap disable rule — flex only, per `GapRow.tsx`'s own
  // doc and this work order's own P0 evidence (F3 fixture). No equivalent
  // evidence exists for grid, so both stay live there.
  const isWrapping = flexWrap === 'wrap' || flexWrap === 'wrap-reverse'
  const isRowDirection = flexDirection === 'row' || flexDirection === 'row-reverse'
  const rowGapDisabledReason =
    isFlex && !isWrapping && isRowDirection
      ? 'Row gap has no effect — this row never wraps onto a second line'
      : undefined
  const columnGapDisabledReason =
    isFlex && !isWrapping && !isRowDirection
      ? 'Column gap has no effect — this column never wraps onto a second line'
      : undefined

  const gapRow = (
    <GapRow
      rowGapValue={readString(currentStyles, 'rowGap')}
      rowGapIsSet={hasStyleValue(storedStyles.rowGap)}
      rowGapMixed={isMixedStyleValue(storedStyles, currentStyles, 'rowGap')}
      columnGapValue={readString(currentStyles, 'columnGap')}
      columnGapIsSet={hasStyleValue(storedStyles.columnGap)}
      columnGapMixed={isMixedStyleValue(storedStyles, currentStyles, 'columnGap')}
      rowGapDisabledReason={rowGapDisabledReason}
      columnGapDisabledReason={columnGapDisabledReason}
      onChangeRowGap={(v) => onChange('rowGap', v)}
      onChangeColumnGap={(v) => onChange('columnGap', v)}
      onPreview={onPreview}
      onClearPreview={onClearPreview}
    />
  )

  // A layout EXISTS when `display` resolves to one of the four modes, when
  // it holds a keyword the mode buttons cannot represent (`inline-block`,
  // `table`, …  — still a real, load-bearing value the mode row is the only
  // place to see), or when the selection disagrees. Those are the states
  // whose body must be open at rest; everything else is a plain block, and
  // gets the one-row disclosure this section's own doc describes.
  const hasLayout = (layoutMode != null && layoutMode !== 'none') || hasStyleValue(storedStyles.display)
  // Something in this section is set even though no layout is — padding on a
  // plain block, a margin, `overflow: hidden`. The collapsed header shows the
  // dot so a stored value is never silently behind a closed disclosure.
  const hasStoredValue = LAYOUT_PROPERTIES.some((property) => hasStyleValue(storedStyles[property]))

  return (
    <Section
      title="Layout"
      forceOpen={hasLayout}
      indicator={!hasLayout && hasStoredValue}
      indicatorTestId="inspector-layout-indicator"
      flush
      actions={
        hasLayout && layoutMode != null && layoutMode !== 'none' && !isMixed(layoutMode) ? (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Remove layout"
            tooltip="Remove layout"
            onClick={() => applyLayoutMode('none')}
            data-testid="inspector-layout-remove"
          >
            <MinusIcon size={12} aria-hidden="true" />
          </Button>
        ) : !hasLayout ? (
          // Figma's own gesture for this row: `+` adds a vertical stack. The
          // chevron beside the title is what opens the body for padding /
          // margin / clip content without adding a layout at all.
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Add auto layout"
            tooltip="Add auto layout"
            onClick={() => applyLayoutMode('vertical')}
            data-testid="inspector-layout-add"
          >
            <PlusIcon size={12} aria-hidden="true" />
          </Button>
        ) : undefined
      }
    >
      <div className={styles.layoutSection} data-testid="inspector-layout-section">
        <LayoutModeRow
          mode={layoutMode}
          display={display}
          onSelectMode={applyLayoutMode}
          onClearMode={() => applyLayoutMode('none')}
          onSelectDisplayValue={(v) => onChange('display', v)}
          onPreviewDisplayValue={(v) => onPreview({ display: v } as Partial<CSSPropertyBag>)}
          onClearPreview={onClearPreview}
        />

        {isFlex && (
          <div className={styles.alignGapRow}>
            <AlignGrid
              mode="flex"
              flexDirection={flexDirection}
              align={{ value: alignItems, isSet: hasStyleValue(storedStyles.alignItems) }}
              justify={{ value: justifyContent, isSet: hasStyleValue(storedStyles.justifyContent) }}
              onChange={(patch) => onChangeMany({ alignItems: patch.align ?? null, justifyContent: patch.justify ?? null })}
              onClear={() => {
                onClearProperty('alignItems')
                onClearProperty('justifyContent')
              }}
              aria-label="Alignment"
              data-testid="css-align-grid"
            />
            <div className={styles.alignGapFields}>
              <div className={styles.flexHeaderRow}>
                <FlexFlowControl
                  flexDirection={isMixed(currentStyles.flexDirection) ? MIXED : flexDirection}
                  flexWrap={flexWrap}
                  onChangeDirection={(v) => onChange('flexDirection', v)}
                  onChangeWrap={(v) => onChange('flexWrap', v)}
                  onClearWrap={() => onClearProperty('flexWrap')}
                />
              </div>
              {gapRow}
            </div>
          </div>
        )}

        {isGrid && (
          <div className={styles.flexBlock}>
            <GridTrackControl
              label="Columns"
              ariaLabel="Grid template columns"
              value={readString(currentStyles, 'gridTemplateColumns')}
              isSet={hasStyleValue(storedStyles.gridTemplateColumns)}
              mixed={isMixedStyleValue(storedStyles, currentStyles, 'gridTemplateColumns')}
              onChange={(v) => onChange('gridTemplateColumns', v)}
              onClear={() => onClearProperty('gridTemplateColumns')}
            />
            <GridTrackControl
              label="Rows"
              ariaLabel="Grid template rows"
              value={readString(currentStyles, 'gridTemplateRows')}
              isSet={hasStyleValue(storedStyles.gridTemplateRows)}
              mixed={isMixedStyleValue(storedStyles, currentStyles, 'gridTemplateRows')}
              onChange={(v) => onChange('gridTemplateRows', v)}
              onClear={() => onClearProperty('gridTemplateRows')}
            />
            <div className={styles.alignGapRow}>
              <AlignGrid
                mode="grid"
                flexDirection={flexDirection}
                align={{ value: alignItems, isSet: hasStyleValue(storedStyles.alignItems) }}
                justify={{ value: justifyItems, isSet: hasStyleValue(storedStyles.justifyItems) }}
                onChange={(patch) => onChangeMany({ alignItems: patch.align ?? null, justifyItems: patch.justify ?? null })}
                onClear={() => {
                  onClearProperty('alignItems')
                  onClearProperty('justifyItems')
                }}
                aria-label="Alignment"
                data-testid="css-align-grid"
              />
              <div className={styles.alignGapFields}>{gapRow}</div>
            </div>
          </div>
        )}

        {/* Padding and margin, paired on one row — see `.spacingRow`'s own
            comment. Both rest as ONE linked field plus a toggle, so the pair
            costs the row the taller of the two, not the sum. */}
        <div className={styles.spacingRow}>
          <PaddingCluster
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            tokens={spacingTokens}
            onChange={onChange}
            onChangeMany={onChangeMany}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />

          <div className={styles.marginRow}>
            <MarginCluster
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              tokens={spacingTokens}
              onChange={onChange}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
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
        </div>
        {boxModelOpen && (
          <InspectorPopover
            id="layout-box-model"
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

        <ClipContentRow
          activeTab={activeContextId ?? 'base'}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          extraTrigger={
            <LayoutSettingsButton
              display={display}
              activeTab={activeContextId ?? 'base'}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
            />
          }
        />
      </div>
    </Section>
  )
}
