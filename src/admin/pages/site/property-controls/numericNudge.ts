/**
 * numericNudge — keyboard step arithmetic shared by the design-panel value
 * fields (TokenAwareInput's CSS values, NumberControl's unitless numbers).
 *
 * Interaction model mirrors Penpot's numeric input:
 *   - plain ↑/↓  → ±1
 *   - Shift+↑/↓  → ±8   (matches an 8px spacing scale — the "big nudge")
 *   - Alt+↑/↓    → ±0.1 (fine nudge)
 *
 * The value operated on may carry a CSS unit (`16px`, `1.25rem`, `-4%`).
 * A value that isn't a single bare number+unit — `var(--space-md)`, `auto`,
 * `calc(...)`, `10px 20px` — is NOT nudgeable and returns `null`, so token
 * references and keyword values are left untouched.
 */

/** Plain arrow nudge. */
export const BASE_NUDGE = 1
/** Shift+arrow nudge — the "big" step, aligned to an 8px design scale. */
export const SHIFT_NUDGE = 8
/** Alt+arrow nudge — the fine step. */
export const FINE_NUDGE = 0.1

export type NudgeDirection = 'up' | 'down'

/** Keyboard modifiers that select which nudge step applies. */
export interface NudgeModifiers {
  shiftKey: boolean
  altKey: boolean
}

/** Resolves the step magnitude for a keydown event's modifier state. */
export function nudgeStepFor({ shiftKey, altKey }: NudgeModifiers): number {
  if (altKey) return FINE_NUDGE
  if (shiftKey) return SHIFT_NUDGE
  return BASE_NUDGE
}

// A single leading-signed number followed by an optional CSS unit and nothing
// else. Deliberately narrow: multi-value shorthands, functions, and keywords
// don't match, so they fall through as non-nudgeable.
const NUDGEABLE_RE = /^(-?\d*\.?\d+)([a-z%]*)$/i

interface NudgeableNumber {
  number: number
  unit: string
}

/** Parses a bare `<number><unit>` value, or `null` when it isn't one. */
export function parseNudgeableValue(raw: string): NudgeableNumber | null {
  const match = NUDGEABLE_RE.exec(raw.trim())
  if (!match) return null
  const number = Number.parseFloat(match[1])
  if (!Number.isFinite(number)) return null
  return { number, unit: match[2] }
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
