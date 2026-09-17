/**
 * PositionConstraints — Figma's Constraints block for an absolute/fixed
 * element: one row per axis (a constraint dropdown plus the inset field(s)
 * that constraint actually writes), with the crosshair beside them.
 *
 * ## What replaced the side picker
 *
 * This row used to carry a two-option `Left ▾ / Right ▾` (`Top ▾ / Bottom ▾`)
 * select whose only job was choosing which inset property the one value field
 * wrote to. Three of Figma's five constraints had no way to be *chosen* from
 * it — stretch and Scale could only be reached by clicking the crosshair's
 * bars in the right order, and Scale only by un-pinning the last one. The
 * dropdown is now the constraint itself (Left / Right / Left and right /
 * Centre / Scale), reading and writing through `useConstraintAxes` — the
 * same model the crosshair renders, so the two can no longer disagree, and a
 * refused constraint is a disabled option carrying its reason instead of a
 * choice that silently does nothing.
 *
 * The inset FIELDS are unchanged in substance and are still the numbers: one
 * per pinned edge. A constraint that pins both edges (stretch, Scale) shows
 * both, because both are real declarations the user can edit; every other
 * constraint shows the single inset it owns.
 *
 * Extracted out of `PositionSection.tsx` to keep that file under the repo's
 * module-size ceiling (`module-size-budgets.test.ts`) — same ownership, just
 * its own file.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import type { IconComponent } from 'pixel-art-icons/types'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ArrowBarUpIcon } from 'pixel-art-icons/icons/arrow-bar-up'
import { ArrowBarRightIcon } from 'pixel-art-icons/icons/arrow-bar-right'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { ArrowBarLeftIcon } from 'pixel-art-icons/icons/arrow-bar-left'
import type { Token } from '@site/property-controls/tokenUtils'
import { ScrubTokenField } from '../../inspector/sections/LayoutSection/ScrubTokenField'
import { ConstraintsDiagram } from './ConstraintsDiagram'
import { ALL_CONSTRAINT_MODES, AXIS_PROPERTIES, type ConstraintAxis, type ConstraintMode } from './constraintMapping'
import { CONSTRAINT_MODE_LABELS } from './constraintModeLabels'
import { useConstraintAxes, type ConstraintAxesApi } from './useConstraintAxes'
import { hasStyleValue } from './styleValueUtils'
import posStyles from './PositionControls.module.css'

/**
 * The offset field's in-field mark, which is also its scrub handle. It names
 * the edge that field measures from — a "24px" under the Right constraint has
 * to look like it belongs to `right`, not to whichever edge the row started
 * on.
 */
const SIDE_ICONS: Record<'left' | 'right' | 'top' | 'bottom', IconComponent> = {
  top: ArrowBarUpIcon,
  right: ArrowBarRightIcon,
  bottom: ArrowBarDownIcon,
  left: ArrowBarLeftIcon,
}

/**
 * The glyph is a component VALUE looked up per render, so it is rendered
 * through this module-scope wrapper rather than inline — an inline component
 * value resets its state on every pass (`react-hooks/static-components`).
 * Same shape as `ClassPropertyRow`'s `PropertyGlyph`; the local is `Mark`, not
 * `Icon`, because `direct-icon-imports.test.ts` scans for that literal tag.
 */
function SideGlyph({ icon: Mark }: { icon: IconComponent }) {
  return <Mark size={13} />
}

/** Which inset properties one constraint actually declares. */
function pinnedSides(axis: ConstraintAxis, mode: ConstraintMode | null): ReadonlyArray<'left' | 'right' | 'top' | 'bottom'> {
  const props = AXIS_PROPERTIES[axis]
  if (mode === 'end') return [props.end]
  if (mode === 'stretch' || mode === 'scale') return [props.start, props.end]
  // `start`, `center`, and "nothing declared yet" all edit the start inset —
  // centring's own `50%` lives there too, and an untouched axis has to offer
  // somewhere to type before a constraint exists to read back.
  return [props.start]
}

interface PositionConstraintsProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  /** Patch-shaped commit — one constraint change, one history entry. */
  onChangeMany: (patch: Record<string, string | null>) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

export function PositionConstraints({
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onClear,
  onChangeMany,
  onPreview,
  onClearPreview,
}: PositionConstraintsProps) {
  const axes = useConstraintAxes({ storedStyles, currentStyles, onChangeMany })

  return (
    <div className={posStyles.constraintGrid}>
      <div className={posStyles.constraintAxisStack}>
        <ConstraintAxisField
          axis="x"
          axisLabel="X"
          axes={axes}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onClear={onClear}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
        <ConstraintAxisField
          axis="y"
          axisLabel="Y"
          axes={axes}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onClear={onClear}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
      </div>
      <ConstraintsDiagram axes={axes} />
    </div>
  )
}

interface ConstraintAxisFieldProps {
  axis: ConstraintAxis
  /** Accessible-only axis name (e.g. "X"), used to name the dropdown and each field. */
  axisLabel: string
  axes: ConstraintAxesApi
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function ConstraintAxisField({
  axis,
  axisLabel,
  axes,
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: ConstraintAxisFieldProps) {
  const props = AXIS_PROPERTIES[axis]
  const mode = axes.modeFor(axis)
  const sides = pinnedSides(axis, mode)

  const options = ALL_CONSTRAINT_MODES.map((candidate) => {
    const refusal = axes.refusalFor(axis, candidate)
    const text = CONSTRAINT_MODE_LABELS[axis][candidate]
    return {
      value: candidate,
      // A disabled option still has to say WHY — §8.4's disabled-with-a-reason
      // posture, carried on the option's own label since the reason is
      // per-option, not per-control.
      label: refusal ? <span title={refusal}>{text}</span> : text,
      textValue: text,
      disabled: refusal !== null && candidate !== mode,
    }
  })

  return (
    <div className={posStyles.constraintCell} data-testid={`css-constraint-${props.start}-${props.end}`}>
      <Select
        fieldSize="xs"
        aria-label={`${axisLabel} constraint`}
        title={axes.gate.ok ? undefined : axes.gate.reason}
        disabled={!axes.gate.ok}
        value={mode ?? ''}
        options={options}
        className={posStyles.constraintSelect}
        onChange={(e) => axes.applyMode(axis, e.target.value as ConstraintMode)}
      />
      {sides.map((side) => (
        <ConstraintOffsetField
          key={side}
          side={side}
          axisLabel={axisLabel}
          primary={side === props.start}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          tokens={tokens}
          onChange={onChange}
          onClear={onClear}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
      ))}
    </div>
  )
}

interface ConstraintOffsetFieldProps {
  side: 'left' | 'right' | 'top' | 'bottom'
  axisLabel: string
  /** The axis's START inset keeps the row's original test id — it is the field that is always present. */
  primary: boolean
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function ConstraintOffsetField({
  side,
  axisLabel,
  primary,
  storedStyles,
  currentStyles,
  tokens,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: ConstraintOffsetFieldProps) {
  const storedValue = storedStyles[side]
  const isSet = hasStyleValue(storedValue)
  const currentValue = currentStyles[side]
  const placeholder = !isSet ? (hasStyleValue(currentValue) ? String(currentValue) : 'auto') : undefined
  const testIdSuffix = primary ? sideAxisPair(side) : side

  return (
    <div className={posStyles.constraintField}>
      <ScrubTokenField
        aria-label={`${axisLabel} offset (${side})`}
        value={isSet ? String(storedValue) : undefined}
        placeholder={placeholder}
        prefix={<SideGlyph icon={SIDE_ICONS[side]} />}
        tokens={tokens}
        onCommit={(resolved) => onChange(side, resolved)}
        onPreview={onPreview ? (resolved) => onPreview(side, resolved) : undefined}
        onClearPreview={onClearPreview}
        className={posStyles.constraintInput}
        data-testid={`css-constraint-input-${testIdSuffix}`}
      />
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label={`Clear ${side} offset`}
          tooltip="Clear offset"
          onClick={() => onClear(side)}
          className={posStyles.constraintClearBtn}
        >
          <CloseIcon size={12} color="currentColor" />
        </Button>
      )}
    </div>
  )
}

/** The axis's `start-end` pair name, kept as the primary field's test id. */
function sideAxisPair(side: 'left' | 'right' | 'top' | 'bottom'): string {
  return side === 'left' || side === 'right' ? 'left-right' : 'top-bottom'
}
