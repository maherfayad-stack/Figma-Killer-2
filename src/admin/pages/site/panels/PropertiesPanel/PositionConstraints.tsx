/**
 * PositionConstraints — F29's absolute/fixed shape: an X row and a Y row,
 * each a side picker (`Left ▾`/`Right ▾`, `Top ▾`/`Bottom ▾`) plus one value
 * field. The crosshair widget F29 also shows is optional polish, omitted
 * here — the two pickers are the substance (they choose which real CSS
 * property the value lands on).
 *
 * Extracted out of `PositionSection.tsx` to keep that file under the
 * repo's module-size ceiling (`module-size-budgets.test.ts`) — same
 * ownership, just its own file.
 */
import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import type { Token } from '@site/property-controls/tokenUtils'
import { hasStyleValue } from './styleValueUtils'
import posStyles from './PositionSection.module.css'

interface PositionConstraintsProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

export function PositionConstraints({
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
