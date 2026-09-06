/**
 * RotationRow — F1's third row. Reads/writes the STANDALONE `rotate` CSS
 * property (never a function inside `transform`) — see `PositionSection.tsx`'s
 * module doc for why that sidesteps the whole "parse and rewrite a function
 * list" problem instead of solving it.
 *
 * The one thing this still has to check: whether `transform` ALREADY
 * contains a rotate function. If it does, this node's rotation lives there,
 * and adding a second, independent `rotate` declaration wouldn't replace it
 * — CSS applies `rotate` first and then `transform`, so both would apply and
 * the two rotations would silently compound. That is exactly the kind of
 * write this codebase refuses: fall back to the raw `transform` row, with a
 * reason, rather than add a value on top of a value the user can't see.
 *
 * Flip (horizontal/vertical) is F1's other third-row control
 * (`scaleX(-1)`/`scaleY(-1)`) and carries the identical "which `transform`
 * function is this" ambiguity for a control used far less often than
 * rotation — skipped here, follow-up.
 *
 * Extracted out of `PositionSection.tsx` to keep that file under the repo's
 * module-size ceiling (`module-size-budgets.test.ts`) — same ownership,
 * just its own file.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ScrubInput } from '@ui/components/ScrubInput'
import { RotateIcon } from '@ui/components/InspectorIcons'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ClassPropertyRow } from './ClassPropertyRow'
import { hasStyleValue } from './styleValueUtils'
import posStyles from './PositionSection.module.css'

/** Matches `rotate(`, `rotateX(`, `rotateY(`, `rotateZ(`, `rotate3d(` — every
 *  rotate-family transform FUNCTION name, case-insensitive. */
const TRANSFORM_ROTATE_FN_RE = /\brotate(?:3d|[xyz])?\s*\(/i

interface RotationRowProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

export function RotationRow({
  storedStyles,
  currentStyles,
  onChange,
  onClearProperty,
  onPreview,
  onClearPreview,
}: RotationRowProps) {
  const transformValue = hasStyleValue(storedStyles.transform) ? storedStyles.transform : currentStyles.transform
  const transformHasRotateFn = typeof transformValue === 'string' && TRANSFORM_ROTATE_FN_RE.test(transformValue)

  // Refused: this element's rotation already lives inside `transform`.
  // Fall back to the raw, honest row for `transform` itself instead of a
  // rotate field that would silently add a SECOND rotation on top of it.
  if (transformHasRotateFn) {
    const isSet = hasStyleValue(storedStyles.transform)
    return (
      <div className={posStyles.rotationFallback}>
        <p className={posStyles.rotationFallbackNote}>
          Rotation is already set inside this element&rsquo;s <code>transform</code> — edit it there so there
          isn&rsquo;t a second, conflicting rotation.
        </p>
        <ClassPropertyRow
          property="transform"
          value={isSet ? (storedStyles.transform as string) : undefined}
          placeholder={!isSet ? (currentStyles.transform as string | undefined) : undefined}
          isSet={isSet}
          onChange={onChange}
          onRemove={onClearProperty}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
      </div>
    )
  }

  const rotateProp = 'rotate' as keyof CSSPropertyBag
  const stored = storedStyles.rotate
  const isSet = hasStyleValue(stored)
  const current = currentStyles.rotate
  const placeholder = !isSet ? (hasStyleValue(current) ? String(current) : '0deg') : undefined

  return (
    <div className={posStyles.rotationCell} data-testid="css-rotation-input" data-state={isSet ? 'set' : 'unset'}>
      <ScrubInput
        aria-label="Rotation"
        label={<RotateIcon size={13} aria-hidden="true" />}
        value={isSet ? String(stored) : undefined}
        placeholder={placeholder}
        unit="deg"
        step={1}
        shiftStep={15}
        onChange={(next) => onChange(rotateProp, next)}
        onPreview={onPreview ? (next) => onPreview(rotateProp, next) : undefined}
        onClearPreview={onClearPreview}
        className={posStyles.rotationInput}
      />
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label="Clear rotation"
          tooltip="Clear rotation"
          onClick={() => onClearProperty(rotateProp)}
          className={posStyles.rotationClearBtn}
        >
          <CloseIcon size={12} color="currentColor" />
        </Button>
      )}
    </div>
  )
}
