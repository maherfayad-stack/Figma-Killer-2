/**
 * PositionSection — visual editor for the `position` CSS section.
 *
 * G10 (STUDIO-INSPECTOR-DISCLOSURE-PLAN.md) — Figma's F1/F2/F29 shape:
 *
 *   • AlignBar          — the 7-button align/distribute/tidy row (F1, F2),
 *                         mounted here for the single selected node. Align
 *                         writes either the node's own `alignSelf`/
 *                         `justifySelf` or, when this is the parent's only
 *                         child, the PARENT's `justifyContent` as an inline
 *                         style (never a shared class — no blast radius).
 *                         Every edge with no single honest CSS write renders
 *                         disabled with the reason as its tooltip — see
 *                         `resolveAlignWrite`.
 *   • PositionSwitcher  — connected `[Relative | Absolute | ▼]` segmented
 *                         control with a dropdown trail. `fixed | sticky |
 *                         static` (and any custom value) fall through to a
 *                         full-width chip + close-button layout, mirroring
 *                         DisplaySwitcher's three-state shape.
 *   • DirectionInput    — compact icon-as-label cell for one offset
 *                         (top/right/bottom/left), used for `relative` /
 *                         `sticky` — those have no "constraints" metaphor
 *                         (F29 is absolute-only per Law 5), so all four
 *                         TRBL cells render together, as before.
 *   • ConstraintAxisField — F29's `absolute`/`fixed` shape: an X row and a Y
 *                         row, each a `Left ▾`/`Right ▾` (or `Top ▾`/
 *                         `Bottom ▾`) side picker plus one value field.
 *                         Switching the side MOVES the value (clears the
 *                         old property, writes the new one) rather than
 *                         leaving both set.
 *   • zIndex            — moved off the resident rows (Law 2) behind a
 *                         small sliders-icon affordance opening a
 *                         `ContextMenu` with the existing generic row.
 *                         `InspectorPopover` (built elsewhere this wave) is
 *                         the intended long-term home — see the comment
 *                         at its call site below.
 *
 * Reuses chip / track styles from LayoutSection.module.css so the visual
 * vocabulary stays in one place — `displayRow`, `displayChipGroup`, etc.
 * New, section-specific styles (align row spacing, constraint cells, the
 * settings trigger) live in this component's own `PositionSection.module.css`
 * rather than growing LayoutSection's.
 */

import { useRef, useState } from 'react'
import type { IconComponent } from 'pixel-art-icons/types'
import type { CSSPropertyBag } from '@core/page-tree'
import { getParent } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu } from '@ui/components/ContextMenu'
import { AlignBar, type AlignEdge } from '@ui/components/AlignBar'
import { Select } from '@ui/components/Select'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { ArrowBarUpIcon } from 'pixel-art-icons/icons/arrow-bar-up'
import { ArrowBarRightIcon } from 'pixel-art-icons/icons/arrow-bar-right'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { ArrowBarLeftIcon } from 'pixel-art-icons/icons/arrow-bar-left'
import { ClassPropertyRow } from './ClassPropertyRow'
import { DropdownSwitcher } from './DropdownSwitcher'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens, type Token } from '@site/property-controls/tokenUtils'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue, readString } from './styleValueUtils'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import { ALL_ALIGN_EDGES, resolveAlignWrite, type ParentLayoutInfo } from './resolveAlignWrite'
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
      <ZIndexSettingsRow
        key={`${activeTab}-zIndex`}
        storedStyles={storedStyles}
        currentStyles={currentStyles}
        onChange={onChange}
        onRemove={onRemove}
        onPreview={previewProperty}
        onClearPreview={onClearPreview}
      />
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

// ---------------------------------------------------------------------------
// PositionConstraints — F29's absolute/fixed shape: an X row and a Y row,
// each a side picker (`Left ▾`/`Right ▾`, `Top ▾`/`Bottom ▾`) plus one value
// field. The crosshair widget F29 also shows is optional polish, omitted
// here — the two pickers are the substance (they choose which real CSS
// property the value lands on).
// ---------------------------------------------------------------------------

interface PositionConstraintsProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function PositionConstraints({
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: PositionConstraintsProps) {
  return (
    <div className={posStyles.constraintGrid}>
      <ConstraintAxisField
        axisLabel="X"
        sideA="left"
        sideB="right"
        sideALabel="Left"
        sideBLabel="Right"
        storedStyles={storedStyles}
        currentStyles={currentStyles}
        tokens={tokens}
        onChange={onChange}
        onClear={onClear}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
      />
      <ConstraintAxisField
        axisLabel="Y"
        sideA="top"
        sideB="bottom"
        sideALabel="Top"
        sideBLabel="Bottom"
        storedStyles={storedStyles}
        currentStyles={currentStyles}
        tokens={tokens}
        onChange={onChange}
        onClear={onClear}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
      />
    </div>
  )
}

interface ConstraintAxisFieldProps {
  /** Accessible-only axis name (e.g. "X"), not rendered — the side select IS the label. */
  axisLabel: string
  sideA: 'left' | 'top'
  sideB: 'right' | 'bottom'
  sideALabel: string
  sideBLabel: string
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function ConstraintAxisField({
  axisLabel,
  sideA,
  sideB,
  sideALabel,
  sideBLabel,
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: ConstraintAxisFieldProps) {
  const aSet = hasStyleValue(storedStyles[sideA])
  const bSet = hasStyleValue(storedStyles[sideB])
  // Nothing committed yet — remember which side the user picked so the
  // select doesn't snap back before a value exists to anchor it to. Once
  // either property is actually set, the STORED data is the source of
  // truth and this local pick is ignored.
  const [pendingSide, setPendingSide] = useState<'left' | 'top' | 'right' | 'bottom'>(sideA)
  const effectiveSide = aSet ? sideA : bSet ? sideB : pendingSide

  const storedValue = storedStyles[effectiveSide]
  const isSet = hasStyleValue(storedValue)
  const currentValue = currentStyles[effectiveSide]
  const placeholder = !isSet
    ? hasStyleValue(currentValue)
      ? String(currentValue)
      : 'auto'
    : undefined

  function handleSideChange(nextSide: 'left' | 'top' | 'right' | 'bottom') {
    if (nextSide === effectiveSide) return
    if (isSet) {
      // Move, don't duplicate: write the new property with the current
      // value, then clear whichever side(s) were carrying it. Two store
      // calls (not one atomic patch) — PositionSection only has a
      // single-property `onChange`/`onClear` pair to work with (the
      // target-agnostic bag it edits, class or inline, is chosen by its
      // caller), so this lands as two undo entries today. A single-call
      // multi-key commit would need `StyleSectionsEditor`/`StyleRuleComposer`/
      // `InlineStyleComposer` to grow a patch-shaped commit prop — out of
      // this file's ownership for G10, flagged in the handoff instead.
      onChange(nextSide, storedValue as string | number)
      if (aSet) onClear(sideA)
      if (bSet) onClear(sideB)
    } else {
      setPendingSide(nextSide)
    }
  }

  return (
    <div className={posStyles.constraintCell} data-testid={`css-constraint-${sideA}-${sideB}`}>
      <Select
        fieldSize="xs"
        aria-label={`${axisLabel} anchor side`}
        value={effectiveSide}
        className={posStyles.constraintSelect}
        onChange={(e) => handleSideChange(e.target.value as 'left' | 'top' | 'right' | 'bottom')}
      >
        <option value={sideA}>{sideALabel}</option>
        <option value={sideB}>{sideBLabel}</option>
      </Select>
      <TokenAwareInput
        aria-label={`${axisLabel} offset (${effectiveSide})`}
        value={isSet ? String(storedValue) : undefined}
        placeholder={placeholder}
        tokens={tokens}
        onCommit={(resolved) => onChange(effectiveSide, resolved)}
        onPreview={onPreview ? (resolved) => onPreview(effectiveSide, resolved) : undefined}
        onClearPreview={onClearPreview}
        className={posStyles.constraintInput}
      />
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label={`Clear ${sideALabel.toLowerCase()}/${sideBLabel.toLowerCase()} offset`}
          tooltip="Clear offset"
          onClick={() => onClear(effectiveSide)}
          className={posStyles.constraintClearBtn}
        >
          <CloseIcon size={12} color="currentColor" />
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SingleNodeAlignRow — mounts AlignBar for the currently selected node,
// resolving each of the 6 align edges against its REAL parent (a live
// `getComputedStyle` read — never a guess, see `resolveAlignWrite`).
// ---------------------------------------------------------------------------

interface SingleNodeAlignRowProps {
  /** The SAME per-property commit the rest of PositionSection writes through
   *  — whichever bag is active (a class, via `StyleRuleComposer`, or a
   *  node's inline styles, via `InlineStyleComposer`). Used for the `self`
   *  resolution (`alignSelf`/`justifySelf`) so align never opens a second,
   *  competing write path for the currently edited node's own properties. */
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

function SingleNodeAlignRow({ onChange }: SingleNodeAlignRowProps) {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const page = useEditorStore(selectActiveCanvasPage)
  const setNodeInlineStyles = useEditorStore((s) => s.setNodeInlineStyles)

  const parentNode = selectedNodeId && page ? getParent(page, selectedNodeId) : undefined
  const parentComputed = useFrameComputedStyleValues(parentNode?.id ?? null, activeBreakpointId, [
    'display',
    'flexDirection',
  ])

  const parentLayout: ParentLayoutInfo | null =
    parentNode && parentComputed
      ? {
          display: parentComputed.display,
          flexDirection: parentComputed.flexDirection || 'row',
          siblingCount: parentNode.children.length,
        }
      : null

  const noParentReason = !selectedNodeId
    ? 'No element selected.'
    : !parentNode
      ? 'This element has no parent to align within.'
      : "Can't read the parent's layout — no live canvas frame is rendering it yet."

  const alignDisabledReasons: Partial<Record<AlignEdge, string>> = {}
  for (const edge of ALL_ALIGN_EDGES) {
    const resolution = resolveAlignWrite(edge, parentLayout)
    if (resolution.target === 'unavailable') {
      alignDisabledReasons[edge] = parentLayout ? resolution.reason : noParentReason
    }
  }

  function handleAlign(edge: AlignEdge) {
    const resolution = resolveAlignWrite(edge, parentLayout)
    if (resolution.target === 'unavailable') return
    if (resolution.target === 'self') {
      // The node's OWN property — write it through the same bag every other
      // control in this section writes through (class or inline, whichever
      // is active), never a second, competing path.
      onChange(resolution.property, resolution.value)
      return
    }
    if (parentNode) {
      // The PARENT's property — always the parent's own inline style, never
      // one of its (possibly shared) classes. A class write here would have
      // an unbounded blast radius; the parent's inline `style=""` is a
      // single, real, per-node location no other node can be affected by.
      setNodeInlineStyles(parentNode.id, { [resolution.property]: resolution.value })
    }
  }

  return (
    <AlignBar
      className={posStyles.alignRow}
      count={1}
      minAlign={0}
      onAlign={handleAlign}
      alignDisabledReasons={alignDisabledReasons}
    />
  )
}

// ---------------------------------------------------------------------------
// ZIndexSettingsRow — z-index moved off the resident rows (Law 2) behind a
// small sliders-icon trigger. `ContextMenu` stands in for the popover; once
// `InspectorPopover` (built elsewhere this wave) exists, this trigger should
// open that instead — same content, real focus trap + Esc/outside dismiss.
// ---------------------------------------------------------------------------

interface ZIndexSettingsRowProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function ZIndexSettingsRow({
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: ZIndexSettingsRowProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const zIndexStored = storedStyles.zIndex
  const zIndexIsSet = hasStyleValue(zIndexStored)
  const zIndexCurrent = currentStyles.zIndex
  const zIndexFallback = hasStyleValue(zIndexCurrent) ? zIndexCurrent : getCSSPropertyDefaultValue('zIndex')

  return (
    <div className={posStyles.settingsRow}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Position settings"
        tooltip="Z-index"
        data-testid="position-settings-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontalIcon size={14} aria-hidden="true" />
      </Button>
      {zIndexIsSet && (
        <span className={posStyles.settingsBadge}>z {String(zIndexStored)}</span>
      )}
      {open && (
        <ContextMenu
          ariaLabel="Position settings"
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="bottom"
          offset={6}
          width={220}
          onClose={() => setOpen(false)}
        >
          <div className={posStyles.settingsMenuTitle}>Z-index</div>
          <ClassPropertyRow
            property="zIndex"
            value={zIndexIsSet ? (zIndexStored as string | number) : undefined}
            placeholder={!zIndexIsSet ? zIndexFallback : undefined}
            isSet={zIndexIsSet}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </ContextMenu>
      )}
    </div>
  )
}
