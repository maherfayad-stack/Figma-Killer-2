/**
 * numericNudge — THE step model for every numeric field in the editor.
 * `ScrubInput`, `TokenAwareInput`, `TextControl`, `NumberControl` and the frame
 * W/H fields all resolve their step from here, so a number moves identically
 * wherever it is typed — and, since W8-2, wherever it is DRAGGED: the scrub
 * gesture (`useScrubDrag`) resolves its per-pixel scale from `nudgeStepFor` too.
 *
 * Figma's model, which is the one we ship:
 *   - plain ↑/↓ or 1px of drag  → ±1
 *   - Shift                     → ±10  (the "big nudge")
 *   - Alt                       → ±0.1 (the fine nudge; beats Shift when both
 *                                       are held — the more specific request
 *                                       wins)
 *
 * There used to be three models: ±10 in `ScrubInput`, ±8 in this file, and a
 * hand-rolled ±8 in `FrameSizePanel`. Which step a field took depended on which
 * of three components happened to render it — invisible in any one field and
 * maddening across two. There is now one set of numbers and one resolver
 * (`nudgeStepFor`), and both live in `scrubMath.ts` (see below) so the gesture
 * in `src/ui` can reach them without a fourth copy.
 *
 * The value operated on may carry a CSS unit (`16px`, `1.25rem`, `-4%`) or be
 * arithmetic the shared evaluator can reduce (`100/2`, `100 + 8`). Anything
 * else — `var(--space-md)`, `auto`, `calc(...)`, `10px 20px` — is NOT
 * nudgeable and returns `null`, so token references and keyword values are
 * left untouched.
 */

import { evaluateNumericExpression } from '@ui/components/ScrubInput'

// The three magnitudes and their resolver are DEFINED in `scrubMath.ts`, at
// the bottom of the dependency graph, because `src/ui` cannot import from
// `src/admin` and the drag gesture (`useScrubDrag`) needs the same ladder the
// keyboard uses. Re-exported here so admin code keeps importing the model
// from the module whose header explains it.
export {
  BASE_NUDGE,
  FINE_NUDGE,
  nudgeStepFor,
  SHIFT_NUDGE,
  type NudgeModifiers,
} from '@ui/components/ScrubInput'
import { nudgeStepFor } from '@ui/components/ScrubInput'

export type NudgeDirection = 'up' | 'down'

interface NudgeableNumber {
  number: number
  unit: string
}

/**
 * Parses a nudgeable value — a bare `<number><unit>` (`16px`, `-4%`, `12`)
 * or arithmetic that reduces to one (`100/2`, `100 + 8`) — or `null` when it
 * isn't one. The grammar lives in ONE place, `evaluateNumericExpression`
 * (`@ui/components/ScrubInput`), so a field that accepts maths on commit
 * also accepts it as a nudge baseline instead of going inert the moment the
 * user typed a sum.
 */
export function parseNudgeableValue(raw: string): NudgeableNumber | null {
  const evaluated = evaluateNumericExpression(raw)
  if (!evaluated) return null
  return { number: evaluated.magnitude, unit: evaluated.unit }
}

/**
 * Rounds away binary-float dust (e.g. `0.1 + 0.2`) to a stable short form,
 * then drops trailing zeros. Four decimals is plenty for the 0.1 fine step.
 */
function formatNudged(n: number): string {
  return String(Number(n.toFixed(4)))
}

interface NudgeCssOptions {
  /**
   * When set, an empty/whitespace value is treated as `0` with this unit
   * instead of being left untouched — so a first nudge on an unset field
   * starts counting up from zero (e.g. `emptyUnit: 'px'` → `↑` gives `1px`).
   * Non-empty non-numeric values (`auto`, `var(...)`, `calc(...)`) still
   * return `null` regardless.
   */
  emptyUnit?: string
}

/**
 * Returns the value string after nudging its numeric part in `direction` by
 * `step`, preserving the original unit. Returns `null` when `raw` carries no
 * nudgeable number (leave the field's value untouched in that case), unless
 * `raw` is empty and `emptyUnit` is supplied — then it starts from `0`.
 */
export function nudgeCssValue(
  raw: string,
  direction: NudgeDirection,
  step: number,
  { emptyUnit }: NudgeCssOptions = {},
): string | null {
  const trimmed = raw.trim()
  const parsed =
    trimmed === '' && emptyUnit !== undefined
      ? { number: 0, unit: emptyUnit }
      : parseNudgeableValue(trimmed)
  if (!parsed) return null
  const delta = direction === 'up' ? step : -step
  return formatNudged(parsed.number + delta) + parsed.unit
}

/** Minimal keyboard-event shape the nudge handler needs (React's `KeyboardEvent` satisfies it). */
export interface NudgeKeyEvent {
  key: string
  shiftKey: boolean
  altKey: boolean
  preventDefault(): void
}

/**
 * Shared arrow-key nudge for a text field holding a CSS value. On ↑/↓ it
 * computes the nudged value (see `nudgeCssValue`) and, when the value was
 * nudgeable, calls `preventDefault()` + `apply(next)` and returns `true`.
 * Returns `false` (leaving the event untouched) for any other key, or for a
 * value with no nudgeable number — so the caller's own key handling and the
 * browser's default caret behaviour still run.
 */
export function handleNudgeKeydown(
  e: NudgeKeyEvent,
  value: string,
  apply: (next: string) => void,
  opts: NudgeCssOptions = {},
): boolean {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false
  const next = nudgeCssValue(value, e.key === 'ArrowUp' ? 'up' : 'down', nudgeStepFor(e), opts)
  if (next === null) return false
  e.preventDefault()
  apply(next)
  return true
}

/**
 * Numeric counterpart for unitless controls: nudges `value` in `direction`
 * by `step`, clamped to the optional `min`/`max` bounds.
 */
export function nudgeNumber(
  value: number,
  direction: NudgeDirection,
  step: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const delta = direction === 'up' ? step : -step
  let next = Number(Number(value + delta).toFixed(4))
  if (bounds.min !== undefined && next < bounds.min) next = bounds.min
  if (bounds.max !== undefined && next > bounds.max) next = bounds.max
  return next
}
