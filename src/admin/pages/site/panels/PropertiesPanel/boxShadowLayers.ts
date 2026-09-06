/**
 * boxShadowLayers — pure parse/serialise for the CSS `box-shadow` value
 * (STUDIO-INSPECTOR-DISCLOSURE-PLAN §4 G8, F21).
 *
 * `box-shadow` is a comma-separated LIST of layers, and each layer is itself
 * a small, order-flexible grammar:
 *
 *   [inset]? && <length>{2,4} && <color>?
 *
 * ("&&" = any order, "?" = optional). This module never guesses: it only
 * accepts the shapes it can reconstruct byte-for-byte, and refuses (returns
 * a `'raw'` result) everything else — commas inside `rgba(…)`/`var(…)`, an
 * `inset` keyword sitting somewhere other than the very first or very last
 * token, a colour token interleaved between lengths, more than 4 lengths,
 * unusual whitespace, and so on. Rewriting a user's hand-written shadow into
 * a normalised form we merely GUESSED at is exactly the lying-control bug
 * this codebase refuses to ship (see `CLAUDE.md` §"Studio-specific" and the
 * plan's §7) — a value that doesn't round-trip stays a raw string, in full,
 * with a reason, never silently reformatted or truncated.
 *
 * `EffectsSection.tsx` is the only intended caller: `parseBoxShadowValue`
 * classifies the whole stored value, and the section renders either N
 * structured `PropertyList` rows (the `'layers'` case) or a single raw-text
 * fallback row (the `'raw'` case) from the result.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// Domain type — schema is the source of truth (no parallel `interface`).
// ---------------------------------------------------------------------------

const PositionSchema = Type.Union([
  Type.Literal('leading'),
  Type.Literal('trailing'),
  Type.Literal('none'),
])

export const BoxShadowLayerSchema = Type.Object({
  /** Convenience flag derived from `insetPosition !== 'none'` — what the F21 checkbox reads/writes. */
  inset: Type.Boolean(),
  /** Where the `inset` keyword sits in the original/serialised text. `'none'` when `inset` is false. */
  insetPosition: PositionSchema,
  offsetX: Type.String(),
  offsetY: Type.String(),
  /** `''` when the layer omitted a blur radius (a valid 2-length shadow). */
  blurRadius: Type.String(),
  /** `''` when the layer omitted a spread radius (a valid 2- or 3-length shadow). */
  spreadRadius: Type.String(),
  /** `''` when the layer omitted a colour (CSS then implies `currentColor`). */
  color: Type.String(),
  /** Where `color` sits relative to the length tokens. `'none'` when `color` is `''`. */
  colorPosition: PositionSchema,
})

export type BoxShadowLayer = Static<typeof BoxShadowLayerSchema>

/**
 * The three ways `EffectsSection` can render a stored `box-shadow` value.
 * `'empty'` and `'raw'` both carry no editable layers, but they are NOT the
 * same thing — `'raw'` means the user has a real value that this module
 * refuses to restructure, and it must still render (as text), never vanish.
 */
export type BoxShadowParseResult =
  | { kind: 'empty' }
  | { kind: 'layers'; layers: BoxShadowLayer[] }
  | { kind: 'raw'; raw: string; reason: string }

// ---------------------------------------------------------------------------
// Tokenising — depth-aware so commas/whitespace inside `rgba(…)`, `var(…)`,
// `calc(…)` are never mistaken for a layer or token boundary.
// ---------------------------------------------------------------------------

/** Splits on `separator` at paren-depth 0 only. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** Splits a single layer's text into whitespace-delimited tokens, respecting paren depth. */
function tokenizeLayer(segment: string): string[] {
  const tokens: string[] = []
  let depth = 0
  let current = ''
  for (const char of segment) {
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (/\s/.test(char) && depth === 0) {
      if (current !== '') tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

const LENGTH_RE = /^[+-]?(\d+\.?\d*|\.\d+)[a-zA-Z%]*$/
const CALC_RE = /^calc\(.*\)$/i

function isLengthToken(token: string): boolean {
  return LENGTH_RE.test(token) || CALC_RE.test(token)
}

// ---------------------------------------------------------------------------
// Per-layer parse
// ---------------------------------------------------------------------------

/**
 * Parses ONE layer's text (already split off a top-level comma) into its
 * grammar. Returns `null` when the text doesn't match the accepted shape —
 * the caller treats any single failed layer as the WHOLE value failing to
 * parse (a `box-shadow` list is one property; a half-structured list is not
 * an honest representation of it).
 */
function parseSingleLayer(segment: string): BoxShadowLayer | null {
  const tokens = tokenizeLayer(segment)
  if (tokens.length === 0) return null

  let insetPosition: Static<typeof PositionSchema> = 'none'
  let rest = tokens
  if (tokens[0]!.toLowerCase() === 'inset') {
    insetPosition = 'leading'
    rest = tokens.slice(1)
  } else if (tokens.length > 1 && tokens[tokens.length - 1]!.toLowerCase() === 'inset') {
    insetPosition = 'trailing'
    rest = tokens.slice(0, -1)
  }
  // `inset` anywhere else (or more than once) is too ambiguous to trust.
  if (rest.some((token) => token.toLowerCase() === 'inset')) return null

  const nonLengthIndices: number[] = []
  rest.forEach((token, index) => {
    if (!isLengthToken(token)) nonLengthIndices.push(index)
  })

  let color = ''
  let colorPosition: Static<typeof PositionSchema> = 'none'
  let lengths = rest

  if (nonLengthIndices.length === 1) {
    const index = nonLengthIndices[0]!
    if (index === 0) {
      color = rest[0]!
      colorPosition = 'leading'
      lengths = rest.slice(1)
    } else if (index === rest.length - 1) {
      color = rest[rest.length - 1]!
      colorPosition = 'trailing'
      lengths = rest.slice(0, -1)
    } else {
      // A colour sandwiched between lengths — real CSS, but not a shape we
      // reconstruct with confidence. Refuse rather than guess.
      return null
    }
  } else if (nonLengthIndices.length > 1) {
    return null
  }

  if (lengths.length < 2 || lengths.length > 4) return null

  const [offsetX, offsetY, blurRadius = '', spreadRadius = ''] = lengths

  return {
    inset: insetPosition !== 'none',
    insetPosition,
    offsetX: offsetX!,
    offsetY: offsetY!,
    blurRadius,
    spreadRadius,
    color,
    colorPosition,
  }
}

/**
 * Parses every comma-separated layer of a `box-shadow` value. Pure grammar
 * check — independent of whether the result would round-trip byte-for-byte
 * (see `parseBoxShadowValue`, which adds that check). Returns `null` if ANY
 * layer fails to parse.
 */
export function parseBoxShadowLayers(value: string): BoxShadowLayer[] | null {
  const segments = splitTopLevel(value, ',').map((segment) => segment.trim())
  if (segments.length === 0 || segments.some((segment) => segment === '')) return null
  const layers = segments.map(parseSingleLayer)
  if (layers.some((layer) => layer === null)) return null
  return layers as BoxShadowLayer[]
}

// ---------------------------------------------------------------------------
// Serialise — canonical form. Order matches the token order parsed above so
// a value already in canonical form round-trips exactly.
// ---------------------------------------------------------------------------

export function serializeBoxShadowLayer(layer: BoxShadowLayer): string {
  const parts: string[] = []
  if (layer.inset && layer.insetPosition === 'leading') parts.push('inset')
  if (layer.colorPosition === 'leading' && layer.color !== '') parts.push(layer.color)
  parts.push(layer.offsetX, layer.offsetY)
  if (layer.blurRadius !== '') parts.push(layer.blurRadius)
  if (layer.spreadRadius !== '') parts.push(layer.spreadRadius)
  if (layer.colorPosition === 'trailing' && layer.color !== '') parts.push(layer.color)
  if (layer.inset && layer.insetPosition === 'trailing') parts.push('inset')
  return parts.join(' ')
}

export function serializeBoxShadowLayers(layers: readonly BoxShadowLayer[]): string {
  return layers.map(serializeBoxShadowLayer).join(', ')
}

// ---------------------------------------------------------------------------
// Public entry point — what EffectsSection actually calls.
// ---------------------------------------------------------------------------

/**
 * Classifies a stored `box-shadow` value for rendering. `'layers'` only when
 * the value both parses AND re-serialises byte-for-byte identical to the
 * input — anything else (a grammar we don't accept, or one we accept but
 * whose formatting we can't reproduce exactly: extra whitespace, an unusual
 * token order) is `'raw'`, never silently reformatted.
 */
export function parseBoxShadowValue(value: string | number | undefined | null): BoxShadowParseResult {
  if (value == null) return { kind: 'empty' }
  const trimmed = String(value).trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return { kind: 'empty' }

  const layers = parseBoxShadowLayers(trimmed)
  if (!layers) {
    return {
      kind: 'raw',
      raw: trimmed,
      reason: 'Could not split this into shadow layers — edit it as text so nothing is lost.',
    }
  }

  const reserialized = serializeBoxShadowLayers(layers)
  if (reserialized !== trimmed) {
    return {
      kind: 'raw',
      raw: trimmed,
      reason: 'This value would be reformatted if split into fields, so it stays as text.',
    }
  }

  return { kind: 'layers', layers }
}

// ---------------------------------------------------------------------------
// Layer-list edit helpers — used by EffectsSection's add / remove / reorder.
// ---------------------------------------------------------------------------

/** A fresh drop/inner shadow, in the same shape `0 4px 4px rgba(0, 0, 0, 0.25)` parses to. */
export function createDefaultBoxShadowLayer(inset: boolean): BoxShadowLayer {
  return {
    inset,
    insetPosition: inset ? 'leading' : 'none',
    offsetX: '0',
    offsetY: '4px',
    blurRadius: '4px',
    spreadRadius: '',
    color: 'rgba(0, 0, 0, 0.25)',
    colorPosition: 'trailing',
  }
}

/**
 * Appends a new layer's CSS text to an existing (possibly unset, possibly
 * unparseable) `box-shadow` value. Always safe: `box-shadow` is a
 * comma-joined list, so appending `, <newLayer>` to ANY existing non-empty
 * value is syntactically valid whether or not this module understands the
 * existing part — this is why adding a layer never requires the existing
 * value to parse first.
 */
export function appendBoxShadowLayer(existing: string | number | undefined | null, layerCss: string): string {
  const trimmed = existing == null ? '' : String(existing).trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return layerCss
  return `${trimmed}, ${layerCss}`
}

export function removeBoxShadowLayer(layers: readonly BoxShadowLayer[], index: number): BoxShadowLayer[] {
  return layers.filter((_, i) => i !== index)
}

export function reorderBoxShadowLayers(
  layers: readonly BoxShadowLayer[],
  fromIndex: number,
  toIndex: number,
): BoxShadowLayer[] {
  const next = layers.slice()
  const [moved] = next.splice(fromIndex, 1)
  if (moved) next.splice(toIndex, 0, moved)
  return next
}

export function updateBoxShadowLayer(
  layers: readonly BoxShadowLayer[],
  index: number,
  patch: Partial<BoxShadowLayer>,
): BoxShadowLayer[] {
  return layers.map((layer, i) => (i === index ? { ...layer, ...patch } : layer))
}
