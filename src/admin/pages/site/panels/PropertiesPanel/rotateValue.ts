/**
 * rotateValue — pure read/write for the STANDALONE `rotate` property, shared
 * by the inspector's `RotationRow` and the canvas rotation gesture (P5-F,
 * IX-25), so the two agree on what they may touch and what they write.
 *
 * Why the standalone `rotate` and never `transform: rotate(…)`: an authored
 * `transform` is a function list the user wrote; rewriting one item of it is
 * the "silently rewrite CSS we only partly understood" failure. `rotate` is
 * its own declaration, so a rotation is one honest write in one place — and
 * an authored transform survives it untouched.
 *
 * The one collision it cannot ignore: a `transform` that ALREADY carries a
 * rotate-family function. CSS applies `rotate` and then `transform`, so a
 * second rotation would compound with the first, silently. Both surfaces
 * refuse there ({@link TRANSFORM_ROTATE_FN_RE}).
 */

/** `rotate(`, `rotateX(`, `rotateY(`, `rotateZ(`, `rotate3d(` — every rotate-family transform FUNCTION name. */
export const TRANSFORM_ROTATE_FN_RE = /\brotate(?:3d|[xyz])?\s*\(/i

const ANGLE_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)$/i

const DEGREES_PER_UNIT: Record<string, number> = {
  deg: 1,
  turn: 360,
  rad: 180 / Math.PI,
  grad: 0.9,
}

/**
 * A `rotate` value as plain degrees about z: unset / `none` is 0, a single
 * angle (`30deg`, `0.25turn`, `1rad`, `50grad`) or a `z <angle>` form is that
 * angle. Anything else — a 3D axis, a `var()` — is `null`: not a rotation a
 * 2D gesture can continue without destroying information.
 */
export function parseRotateDegrees(value: unknown): number | null {
  if (value == null) return 0
  const text = String(value).trim()
  if (text === '' || text.toLowerCase() === 'none') return 0
  const angle = text.toLowerCase().startsWith('z ') ? text.slice(2).trim() : text
  const match = ANGLE_RE.exec(angle)
  if (!match) return null
  const degrees = Number.parseFloat(match[1]!) * DEGREES_PER_UNIT[match[2]!.toLowerCase()]!
  return Number.isFinite(degrees) ? degrees : null
}

/** Degrees folded into (-180, 180], to one decimal — the value a rotation writes. */
export function normalizeDegrees(degrees: number): number {
  let folded = degrees % 360
  if (folded > 180) folded -= 360
  if (folded <= -180) folded += 360
  const rounded = Math.round(folded * 10) / 10
  return Object.is(rounded, -0) ? 0 : rounded
}

/** The `rotate` declaration for `degrees`, or `null` (clear it) for no rotation. */
export function rotateDeclaration(degrees: number): string | null {
  const normalized = normalizeDegrees(degrees)
  return normalized === 0 ? null : `${normalized}deg`
}
