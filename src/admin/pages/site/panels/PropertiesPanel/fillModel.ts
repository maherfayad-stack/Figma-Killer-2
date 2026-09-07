/**
 * fillModel — the Fill section's pure COLOUR-channel model: the defaults its
 * `+` buttons write, the content-fit pair, and the gradient edit transforms
 * `GradientEditor` applies.
 *
 * Split out of `FillSection.tsx` when G9's text-fill row landed and that file
 * reached the repo's 700-line module ceiling
 * (`module-size-budgets.test.ts`). The split is by responsibility, not by
 * line count: everything here is a pure function of values, testable without
 * a DOM, while `FillSection.tsx` decides which ROWS exist and
 * `FillSectionParts.tsx` draws them.
 *
 * The `background-image` LAYER STACK — parsing the comma list, its per-layer
 * satellites, and the refusals that keep the round trip byte-identical — is
 * `backgroundLayers.ts`, not this file. Two models, two reasons to change.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import type { ParsedGradient, GradientStop } from './gradientValue'

// ---------------------------------------------------------------------------
// Channels + defaults
// ---------------------------------------------------------------------------

/**
 * `object-fit` / `object-position` are NOT background properties: they size an
 * `<img>`/`<video>`'s OWN replaced content, which paints above the element's
 * background entirely. They used to ride along with the image fill's
 * satellites, which conflated two unrelated things — the per-layer background
 * satellites now live in `backgroundLayers.ts` and these two get their own
 * "Content fit" row, shown only when one of them is set.
 */
export const CONTENT_FIT_PROPS: ReadonlyArray<keyof CSSPropertyBag> = [
  'objectFit',
  'objectPosition',
]

export const DEFAULT_SOLID_FILL = '#000000'
export const DEFAULT_GRADIENT_FILL = 'linear-gradient(180deg, #000000 0%, #ffffff 100%)'
/**
 * What "Add text colour" writes. `currentColor` would be a no-op (it IS the
 * inherited value), so the row would appear without changing anything; a
 * concrete colour is what the user asked for by pressing `+`.
 */
export const DEFAULT_TEXT_FILL = '#000000'

// ---------------------------------------------------------------------------
// Gradient edit transforms — every one returns a NEW gradient, so the editor
// stays a pure render of whatever `gradientValue.ts` parsed.
// ---------------------------------------------------------------------------

const DIRECTION_DEGREES: ReadonlyMap<string, number> = new Map([
  ['to top', 0],
  ['to top right', 45],
  ['to right', 90],
  ['to bottom right', 135],
  ['to bottom', 180],
  ['to bottom left', 225],
  ['to left', 270],
  ['to top left', 315],
])

const ANGLE_TEXT_RE = /^(-?\d+(?:\.\d+)?)(deg|grad|rad|turn)?$/i

export function angleFieldValue(gradient: ParsedGradient): string {
  if (gradient.direction?.kind === 'angle') return gradient.direction.raw
  if (gradient.direction?.kind === 'keyword') return `${DIRECTION_DEGREES.get(gradient.direction.keyword) ?? 180}deg`
  return '180deg'
}

export function withAngleText(gradient: ParsedGradient, text: string): ParsedGradient {
  const match = ANGLE_TEXT_RE.exec(text.trim())
  if (!match) return gradient
  const unit = (match[2]?.toLowerCase() ?? 'deg') as 'deg' | 'grad' | 'rad' | 'turn'
  const raw = match[2] ? text.trim() : `${match[1]}deg`
  return { ...gradient, direction: { kind: 'angle', raw, value: Number(match[1]), unit } }
}

export function withKind(gradient: ParsedGradient, kind: 'linear' | 'radial'): ParsedGradient {
  if (kind === gradient.kind) return gradient
  if (kind === 'radial') return { kind: 'radial', stops: gradient.stops }
  return { kind: 'linear', stops: gradient.stops }
}

export function withStop(gradient: ParsedGradient, index: number, patch: Partial<GradientStop>): ParsedGradient {
  const stops = gradient.stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop))
  return { ...gradient, stops }
}

export function withAddedStop(gradient: ParsedGradient): ParsedGradient {
  const last = gradient.stops[gradient.stops.length - 1]
  return { ...gradient, stops: [...gradient.stops, { color: last?.color ?? '#ffffff', position: undefined }] }
}

export function withRemovedStop(gradient: ParsedGradient, index: number): ParsedGradient {
  return { ...gradient, stops: gradient.stops.filter((_, i) => i !== index) }
}

export function parsePercentText(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^(-?\d+(?:\.\d+)?)%?$/.exec(trimmed)
  return match ? Number(match[1]) : undefined
}
