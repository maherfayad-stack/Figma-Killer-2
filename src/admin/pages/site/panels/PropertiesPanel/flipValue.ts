/**
 * flipValue — pure read/write for Figma's Flip horizontal / Flip vertical
 * (F1, `docs/features/inspector-disclosure.md` §4 G10), backed by the
 * STANDALONE `scale` CSS property.
 *
 * Why `scale` and not `transform: scaleX(-1)`: the same reason `RotationRow`
 * writes the standalone `rotate` — `scale` is its own declaration with its
 * own value, so a flip is one honest write in one honest place. Reaching into
 * a `transform` function list would mean parsing an ordered, arbitrary-length
 * grammar and rewriting one item of it, which is the "silently rewrite CSS we
 * only partly understood" failure this panel refuses everywhere else.
 *
 * The value space we accept is deliberately narrow: one or two plain numbers
 * (`scale: -1 1`, `scale: 2`). CSS also allows percentages and a third
 * z-axis component, and `scale` can hold `none` or a `var()`. None of those
 * are values a two-button flip control can toggle without destroying
 * information, so `parseFlipState` REFUSES them (returns `null`) and the
 * buttons render disabled with the reason — never silently overwritten.
 *
 * The other refusal is a `transform` that already carries a scale-family
 * function: CSS applies `scale` first and then `transform`, so writing both
 * would compound two scalings the user cannot see as one. Same shape as
 * `RotationRow`'s rotate-family check, and for the same reason.
 */

/** Matches `scale(`, `scaleX(`, `scaleY(`, `scaleZ(`, `scale3d(` — every scale-family transform FUNCTION name. */
export const TRANSFORM_SCALE_FN_RE = /\bscale(?:3d|[xyz])?\s*\(/i

/** A plain, unitless CSS number — the only `scale` component this control edits. */
const PLAIN_NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/

export interface FlipState {
  /** X-axis scale factor. Negative means "flipped horizontally". */
  x: number
  /** Y-axis scale factor. Negative means "flipped vertically". */
  y: number
}

/**
 * Read a stored `scale` value into its two axis factors.
 *
 *   - unset / empty / `none` → the identity `{ x: 1, y: 1 }` (nothing flipped)
 *   - `2`                    → `{ x: 2, y: 2 }` (one value means both axes)
 *   - `-1 1`                 → `{ x: -1, y: 1 }`
 *   - anything else          → `null`, meaning "this control must not touch it"
 */
export function parseFlipState(value: unknown): FlipState | null {
  if (value == null) return { x: 1, y: 1 }
  const trimmed = String(value).trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return { x: 1, y: 1 }

  const parts = trimmed.split(/\s+/)
  if (parts.length > 2) return null
  if (!parts.every((part) => PLAIN_NUMBER_RE.test(part))) return null

  const x = Number.parseFloat(parts[0]!)
  const y = parts.length === 2 ? Number.parseFloat(parts[1]!) : x
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * Serialise a flip state back to a `scale` value, or `undefined` when it is
 * the identity — an unflipped element gets no `scale` declaration at all
 * rather than a no-op `scale: 1 1` sitting in the user's stylesheet.
 * Equal factors collapse to CSS's own one-value form.
 */
export function serializeFlipState(state: FlipState): string | undefined {
  if (state.x === 1 && state.y === 1) return undefined
  if (state.x === state.y) return String(state.x)
  return `${state.x} ${state.y}`
}

/** The state after flipping one axis: that axis's factor changes sign. */
export function toggleFlipAxis(state: FlipState, axis: 'x' | 'y'): FlipState {
  return axis === 'x' ? { ...state, x: -state.x } : { ...state, y: -state.y }
}
