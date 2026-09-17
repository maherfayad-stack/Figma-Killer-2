/**
 * borderRadiusShorthand — the pure model behind the radius cluster's link
 * toggle: `border-radius` ⇄ its four corner longhands.
 *
 * WHY THE SHORTHAND AT ALL
 * ------------------------
 * Four equal corners are one fact, and a human writes them as one
 * declaration. The cluster used to emit four longhands even when it was
 * linked, so `border-radius: 12px` in the user's stylesheet came back as four
 * lines the moment anything touched it. Linked now writes the shorthand and
 * clears the longhands; unlinked writes the longhands and clears the
 * shorthand. Never both — a longhand and a shorthand in the same rule resolve
 * by source order, which a property bag does not model.
 *
 * WHAT IT REFUSES
 * ---------------
 * Same posture as `backgroundLayers.ts` and `constraintMapping.ts`'s
 * `parseTranslateAxes`: a value is only split into corners when it can be put
 * back together without guessing.
 *
 *   - an ELLIPTICAL radius (`12px 4px / 8px 2px`) — each corner is then two
 *     radii, which the four-field cluster has nowhere to put;
 *   - a value containing a function call (`calc(1px + 2px)`, `var(--r)`) —
 *     whitespace is not a safe separator inside one, so splitting on it would
 *     mis-attribute the parts;
 *   - more than four components.
 *
 * A refused shorthand keeps its text in the collapsed field, which still
 * edits it as a whole declaration; the per-corner fields disable themselves
 * with the reason rather than offering an edit that would rewrite something
 * the parse did not understand.
 */
import type { CSSPropertyBag } from '@core/page-tree'

/** In `border-radius` shorthand order: top-left, top-right, bottom-right, bottom-left. */
export const RADIUS_CORNERS = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const

export type RadiusCorner = (typeof RADIUS_CORNERS)[number]

export type RadiusCornerValues = Record<RadiusCorner, string>

export function radiusLonghand(corner: RadiusCorner): keyof CSSPropertyBag {
  return `border${corner}Radius` as keyof CSSPropertyBag
}

export type RadiusShorthandParse = { ok: true; corners: RadiusCornerValues } | { ok: false; reason: string }

const ELLIPTICAL_REASON =
  "This element's border-radius sets a second, elliptical radius after the `/` — each corner is two values, which the four corner fields have nowhere to put."
const FUNCTION_REASON =
  "This element's border-radius contains a function call, so its components cannot be told apart by the spaces between them."
const TOO_MANY_REASON = 'A border-radius has at most four components; this one has more.'

/**
 * Split a `border-radius` value into its four corners, applying CSS's own
 * 1/2/3/4-component expansion rules, or refuse by name.
 */
export function parseRadiusShorthand(value: unknown): RadiusShorthandParse {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') return { ok: true, corners: emptyCorners() }
  if (trimmed.includes('/')) return { ok: false, reason: ELLIPTICAL_REASON }
  if (trimmed.includes('(')) return { ok: false, reason: FUNCTION_REASON }

  const parts = trimmed.split(/\s+/)
  if (parts.length > 4) return { ok: false, reason: TOO_MANY_REASON }

  const [a, b, c, d] = parts as [string, string?, string?, string?]
  const topLeft = a
  const topRight = b ?? a
  const bottomRight = c ?? a
  const bottomLeft = d ?? topRight
  return { ok: true, corners: { TopLeft: topLeft, TopRight: topRight, BottomRight: bottomRight, BottomLeft: bottomLeft } }
}

function emptyCorners(): RadiusCornerValues {
  return { TopLeft: '', TopRight: '', BottomRight: '', BottomLeft: '' }
}
