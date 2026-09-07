/**
 * RotationRow — F1's third row: rotation, plus Figma's Flip horizontal /
 * Flip vertical pair. Both write STANDALONE individual-transform properties
 * (`rotate`, `scale`) rather than functions inside `transform` — see
 * `PositionSection.tsx`'s module doc for why that sidesteps the whole "parse
 * and rewrite a function list" problem instead of solving it.
 *
 * Each control checks the one thing that mapping can't ignore: whether
 * `transform` ALREADY contains a function of the same family. If it does,
 * that value lives there, and adding a second, independent declaration
 * wouldn't replace it — CSS applies `rotate`/`scale` first and then
 * `transform`, so both would apply and compound silently. That is exactly the
 * kind of write this codebase refuses. The two refusals are separate, because
 * the collisions are:
 *
 *   - `transform` carries a rotate-family function → the whole row falls back
 *     to the raw `transform` field, with a reason. There is no honest
 *     rotation field to show.
 *   - `transform` carries a scale-family function, or `scale` holds a value
 *     outside the plain-number space this control edits (`50%`, a `var()`, a
 *     third z component) → only the FLIP buttons are refused, disabled with
 *     the reason as their tooltip (§8.4's resolved posture: disabled-with-a-
 *     reason, not absent). Rotation is still honest and stays live.
 *
 * Extracted out of `PositionSection.tsx` to keep that file under the repo's
 * module-size ceiling (`module-size-budgets.test.ts`) — same ownership,
 * just its own file. The flip value model is `flipValue.ts`.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ScrubInput } from '@ui/components/ScrubInput'
import { FlipHorizontalIcon, FlipVerticalIcon, RotateIcon } from '@ui/components/InspectorIcons'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ClassPropertyRow } from './ClassPropertyRow'
import { hasStyleValue } from './styleValueUtils'
import { parseFlipState, serializeFlipState, toggleFlipAxis, TRANSFORM_SCALE_FN_RE } from './flipValue'
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
  const transformText = typeof transformValue === 'string' ? transformValue : ''
  const transformHasRotateFn = TRANSFORM_ROTATE_FN_RE.test(transformText)

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

  const stored = storedStyles.rotate
  const isSet = hasStyleValue(stored)
  const current = currentStyles.rotate
  const placeholder = !isSet ? (hasStyleValue(current) ? String(current) : '0deg') : undefined

  // Flip reads the element's EFFECTIVE scale (its own declaration, else the
  // one it inherits from a losing rule) so the buttons show the state the
  // user can see on canvas, not just what this rule happens to declare.
  const scaleValue = hasStyleValue(storedStyles.scale) ? storedStyles.scale : currentStyles.scale
  const flip = parseFlipState(scaleValue)
  const flipRefusal = TRANSFORM_SCALE_FN_RE.test(transformText)
    ? 'This element is already scaled inside its transform — flipping here would apply a second scale on top of it.'
    : flip === null
      ? `This element's scale (${String(scaleValue)}) isn't a plain number pair, so flipping it would rewrite a value we can't reproduce.`
      : null
  const flipState = flip ?? { x: 1, y: 1 }

  function toggleFlip(axis: 'x' | 'y') {
    onChange('scale', serializeFlipState(toggleFlipAxis(flipState, axis)))
  }

  return (
    <div className={posStyles.rotationCell} data-testid="css-rotation-input" data-state={isSet ? 'set' : 'unset'}>
      <div className={posStyles.rotationField}>
        <ScrubInput
          aria-label="Rotation"
          label={<RotateIcon size={13} aria-hidden="true" />}
          value={isSet ? String(stored) : undefined}
          placeholder={placeholder}
          unit="deg"
          onChange={(next) => onChange('rotate', next)}
          onPreview={onPreview ? (next) => onPreview('rotate', next) : undefined}
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
            onClick={() => onClearProperty('rotate')}
            className={posStyles.rotationClearBtn}
          >
            <CloseIcon size={12} color="currentColor" />
          </Button>
        )}
      </div>
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        pressed={flipState.x < 0}
        disabled={flipRefusal !== null}
        aria-label="Flip horizontal"
        tooltip={flipRefusal ?? 'Flip horizontal'}
        data-testid="css-flip-horizontal"
        className={posStyles.rotationFlipBtn}
        onClick={() => toggleFlip('x')}
      >
        <FlipHorizontalIcon size={13} color="currentColor" />
      </Button>
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        pressed={flipState.y < 0}
        disabled={flipRefusal !== null}
        aria-label="Flip vertical"
        tooltip={flipRefusal ?? 'Flip vertical'}
        data-testid="css-flip-vertical"
        className={posStyles.rotationFlipBtn}
        onClick={() => toggleFlip('y')}
      >
        <FlipVerticalIcon size={13} color="currentColor" />
      </Button>
    </div>
  )
}
