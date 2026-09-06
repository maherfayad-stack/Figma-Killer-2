/**
 * gradientValue — parse/serialize a conservative, exhaustively-tested subset
 * of CSS `linear-gradient()` / `radial-gradient()` into editable stops, for
 * `FillSection`'s image-fill popover (docs/features/inspector-disclosure.md §4 G6,
 * F15).
 *
 * WHY THIS REFUSES SO OFTEN
 * --------------------------
 * `background-image` is real CSS in the user's own source. Silently
 * rewriting it into a "close enough" visual editor is exactly the write this
 * codebase refuses everywhere else — the same rule the disclosure plan
 * applies to `box-shadow` and `transform`. A gradient's grammar has several
 * corners a naive parser gets wrong in ways that are invisible until the
 * published page renders differently from what the author's file actually
 * says: colour hints (`red, 50%, blue`), double-position hard stops
 * (`red 0% 10%`), non-percentage stop lengths, `repeating-*`/`conic-*`
 * functions, CSS Color 4 interpolation methods (`in oklch`), and radial
 * gradients with a size/position (`circle at top`). None of those are
 * supported here — `parseGradient` returns `{ ok: false, reason }` for all
 * of them, and the caller's job is to show that reason and fall back to a
 * raw, honestly-editable text field rather than open a structured editor
 * that would corrupt the value on save.
 *
 * WHAT "ROUND-TRIPS LOSSLESSLY" MEANS HERE
 * ------------------------------------------
 * Not byte-for-byte text equality (`LINEAR-GRADIENT` vs `linear-gradient` is
 * a cosmetic, CSS-equivalent difference this module is allowed to
 * normalize). It means: re-serializing the parsed structure and re-parsing
 * that output must produce a STRUCTURALLY EQUAL `ParsedGradient` — same
 * stops in the same order with the same colours and positions, same
 * direction/shape. `parseGradient` performs this self-check internally
 * before ever returning `ok: true`, so a parser bug (a case the grammar
 * above missed) fails closed as a refusal instead of silently mis-editing
 * the user's file. The one field kept as verbatim original text rather than
 * reformatted from a number is the linear angle (`raw` on
 * `LinearGradientAngle`) — reformatting `33.333deg` through
 * `Number → String` risks a rounding artifact for no benefit, so the
 * original token survives untouched until the user actually edits it.
 *
 * SUPPORTED GRAMMAR
 * -------------------
 *   linear-gradient( [ <angle> | to <side-or-corner> ,]? <stop>, <stop>+ )
 *   radial-gradient( [ circle | ellipse ,]? <stop>, <stop>+ )
 *   <stop> := <colour> <percentage>?
 *
 * `<colour>` is accepted as authored and never validated against a named-
 * colour table or renormalized — hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`,
 * `var(--token)`, `currentColor`, or a bare keyword all pass through
 * unexamined; a misspelled colour is the author's CSS bug, not this parser's
 * job to catch, exactly like typing `bakground: red` and having it rendered
 * as invalid.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GradientKind = 'linear' | 'radial'

export interface GradientStop {
  /** The colour exactly as authored — never renormalized. */
  color: string
  /** Percent position (0-100), or `undefined` for an implicit, evenly-spaced stop. */
  position: number | undefined
}

export interface LinearGradientAngle {
  kind: 'angle'
  /** Original text (`"33.333deg"`) — preserved verbatim so re-serializing never reformats a number the user didn't touch. */
  raw: string
  value: number
  unit: 'deg' | 'grad' | 'rad' | 'turn'
}

export interface LinearGradientKeyword {
  kind: 'keyword'
  /** Lowercased, whitespace-collapsed — e.g. `"to top right"`. */
  keyword: string
}

export interface ParsedGradient {
  kind: GradientKind
  /** `kind: 'linear'` only. `undefined` = CSS's own default (`to bottom`) — omitted on serialize, exactly like the input that had no explicit direction. */
  direction?: LinearGradientAngle | LinearGradientKeyword
  /** `kind: 'radial'` only. `undefined` = CSS's own default (`ellipse`) — omitted on serialize. */
  shape?: 'circle' | 'ellipse'
  /** At least two — `parseGradient` refuses a shorter list, matching the CSS grammar's own minimum. */
  stops: GradientStop[]
}

export type GradientParseResult =
  | { ok: true; gradient: ParsedGradient }
  | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// Tokenizing helpers
// ---------------------------------------------------------------------------

/**
 * Splits `input` on `separator`, ignoring any occurrence nested inside
 * parentheses — so `rgba(0, 0, 0, .5), blue` splits into exactly
 * `["rgba(0, 0, 0, .5)", " blue"]` on `,`, not five pieces.
 */
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === separator && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/**
 * Finds the function name + its ARGUMENT LIST, matching parens by depth
 * rather than a greedy regex — `linear-gradient(red, blue), url('x')` must
 * be recognised as "more than the gradient call alone", not have its
 * trailing `url(...)` silently swallowed into the argument list by a
 * `(.*)`'s greedy match to the LAST `)` in the string.
 */
function matchGradientHead(
  trimmed: string,
): { kind: GradientKind; inner: string } | { error: string } | null {
  const head = /^(linear-gradient|radial-gradient)\s*\(/i.exec(trimmed)
  if (!head) return null

  const openIndex = head[0].length - 1
  let depth = 0
  let closeIndex = -1
  for (let i = openIndex; i < trimmed.length; i++) {
    if (trimmed[i] === '(') depth++
    else if (trimmed[i] === ')') {
      depth--
      if (depth === 0) {
        closeIndex = i
        break
      }
    }
  }
  if (closeIndex === -1) return { error: 'Unbalanced parentheses.' }

  const remainder = trimmed.slice(closeIndex + 1).trim()
  if (remainder !== '') {
    return {
      error:
        'This value has more than one layer (e.g. a gradient plus an image, or two gradients) — the visual editor only supports a single gradient.',
    }
  }

  return {
    kind: head[1]!.toLowerCase() === 'linear-gradient' ? 'linear' : 'radial',
    inner: trimmed.slice(openIndex + 1, closeIndex),
  }
}

const VERTICAL_KEYWORDS = new Set(['top', 'bottom'])
const HORIZONTAL_KEYWORDS = new Set(['left', 'right'])

/**
 * Matches CSS's `to <side-or-corner>` direction grammar exactly — a single
 * side (`to top`), or one vertical + one horizontal keyword in either order
 * (`to top left` / `to left top`). Rejects nonsensical pairs a looser regex
 * would accept, like `to top bottom` or `to top top`.
 */
function matchSideOrCorner(text: string): string | null {
  const match = /^to\s+(.+)$/i.exec(text.trim())
  if (!match) return null
  const words = match[1]!.toLowerCase().trim().split(/\s+/)

  if (words.length === 1) {
    const [word] = words
    return VERTICAL_KEYWORDS.has(word!) || HORIZONTAL_KEYWORDS.has(word!) ? `to ${word}` : null
  }
  if (words.length === 2) {
    const [a, b] = words as [string, string]
    const validPair =
      (VERTICAL_KEYWORDS.has(a) && HORIZONTAL_KEYWORDS.has(b)) ||
      (HORIZONTAL_KEYWORDS.has(a) && VERTICAL_KEYWORDS.has(b))
    return validPair ? `to ${a} ${b}` : null
  }
  return null
}

const ANGLE_RE = /^(-?\d+(?:\.\d+)?)(deg|grad|rad|turn)$/i
const PERCENT_RE = /^(-?\d+(?:\.\d+)?)%$/
const BARE_LENGTH_RE = /^-?\d+(?:\.\d+)?(px|rem|em|vh|vw)$/i
const RADIAL_MODIFIER_RE = /\b(circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner|at)\b/i

// ---------------------------------------------------------------------------
// Stop parsing
// ---------------------------------------------------------------------------

type StopResult = { ok: true; stop: GradientStop } | { ok: false; reason: string }

function parseStop(rawSegment: string): StopResult {
  const trimmed = rawSegment.trim()
  if (!trimmed) return { ok: false, reason: 'A colour stop is empty.' }

  // A "colour hint" — a bare position with no colour, e.g. the `50%` in
  // `red, 50%, blue`. Hints shift where each side's colour finishes
  // interpolating and have no representation in a plain stops-list editor;
  // silently dropping one would change how the gradient renders.
  if (PERCENT_RE.test(trimmed) || BARE_LENGTH_RE.test(trimmed)) {
    return {
      ok: false,
      reason: `Colour hints — a bare position between stops (found "${trimmed}") — aren't supported by the visual editor.`,
    }
  }

  const tokens = splitTopLevel(trimmed, ' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  if (tokens.length === 0) return { ok: false, reason: 'A colour stop is empty.' }
  if (tokens.length === 1) return { ok: true, stop: { color: tokens[0]!, position: undefined } }

  if (tokens.length === 2) {
    const posMatch = PERCENT_RE.exec(tokens[1]!)
    if (!posMatch) {
      return {
        ok: false,
        reason: `Stop positions must be a percentage — found "${tokens[1]}" after "${tokens[0]}".`,
      }
    }
    return { ok: true, stop: { color: tokens[0]!, position: Number(posMatch[1]) } }
  }

  // Three or more space-separated tokens: a double-position hard stop
  // (`red 0% 40%`) or something this grammar doesn't recognise. Either way,
  // decomposing it into one editable position would drop information.
  return {
    ok: false,
    reason: `Colour stop "${trimmed}" has more than one position — double-position hard stops aren't supported by the visual editor.`,
  }
}

// ---------------------------------------------------------------------------
// Structural equality — the self-check's comparator
// ---------------------------------------------------------------------------

function directionsEqual(
  a: LinearGradientAngle | LinearGradientKeyword | undefined,
  b: LinearGradientAngle | LinearGradientKeyword | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'angle' && b.kind === 'angle') return a.value === b.value && a.unit === b.unit
  if (a.kind === 'keyword' && b.kind === 'keyword') return a.keyword === b.keyword
  return false
}

function gradientsStructurallyEqual(a: ParsedGradient, b: ParsedGradient): boolean {
  if (a.kind !== b.kind) return false
  if (a.stops.length !== b.stops.length) return false
  for (let i = 0; i < a.stops.length; i++) {
    const sa = a.stops[i]!
    const sb = b.stops[i]!
    if (sa.color !== sb.color) return false
    if ((sa.position ?? null) !== (sb.position ?? null)) return false
  }
  if (a.kind === 'linear') return directionsEqual(a.direction, b.direction)
  return (a.shape ?? null) === (b.shape ?? null)
}

// ---------------------------------------------------------------------------
// parseGradientOnce — the real grammar, no self-check (avoids recursion)
// ---------------------------------------------------------------------------

function parseGradientOnce(value: string): GradientParseResult {
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, reason: 'Value is empty.' }

  const head = matchGradientHead(trimmed)
  if (head === null) {
    return { ok: false, reason: 'Not a single linear-gradient() or radial-gradient() value.' }
  }
  if ('error' in head) {
    return { ok: false, reason: head.error }
  }
  const { kind, inner } = head

  const segments = splitTopLevel(inner, ',').map((s) => s.trim())
  if (segments.length === 0 || segments.some((s) => s === '')) {
    return { ok: false, reason: 'A gradient argument is empty — check for a stray comma.' }
  }

  let direction: LinearGradientAngle | LinearGradientKeyword | undefined
  let shape: 'circle' | 'ellipse' | undefined
  let stopSegments = segments

  const first = segments[0]!
  if (kind === 'linear') {
    const angleMatch = ANGLE_RE.exec(first)
    const sideOrCorner = matchSideOrCorner(first)
    if (angleMatch) {
      direction = {
        kind: 'angle',
        raw: first,
        value: Number(angleMatch[1]),
        unit: angleMatch[2]!.toLowerCase() as LinearGradientAngle['unit'],
      }
      stopSegments = segments.slice(1)
    } else if (sideOrCorner) {
      direction = { kind: 'keyword', keyword: sideOrCorner }
      stopSegments = segments.slice(1)
    } else if (/^to\b/i.test(first)) {
      return { ok: false, reason: `Unsupported direction keyword: "${first}".` }
    }
  } else {
    const lowerFirst = first.toLowerCase()
    if (lowerFirst === 'circle' || lowerFirst === 'ellipse') {
      shape = lowerFirst
      stopSegments = segments.slice(1)
    } else if (RADIAL_MODIFIER_RE.test(first)) {
      return {
        ok: false,
        reason:
          'Radial gradients with a size or position (e.g. "at center", "closest-side") aren’t supported by the visual editor.',
      }
    }
  }

  if (stopSegments.length < 2) {
    return { ok: false, reason: 'A gradient needs at least two colour stops.' }
  }

  const stops: GradientStop[] = []
  for (const segment of stopSegments) {
    const result = parseStop(segment)
    if (!result.ok) return result
    stops.push(result.stop)
  }

  return { ok: true, gradient: { kind, direction, shape, stops } }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses `value` and self-checks the result by re-serializing and
 * re-parsing it, refusing (rather than trusting a parse this module got
 * subtly wrong) unless the two are structurally identical — see the module
 * doc's "WHAT ROUND-TRIPS LOSSLESSLY MEANS HERE".
 */
export function parseGradient(value: string): GradientParseResult {
  const first = parseGradientOnce(value)
  if (!first.ok) return first

  const reserialized = serializeGradient(first.gradient)
  const second = parseGradientOnce(reserialized)
  if (!second.ok || !gradientsStructurallyEqual(first.gradient, second.gradient)) {
    return {
      ok: false,
      reason: 'This gradient didn’t survive a round-trip check — refusing to risk rewriting it.',
    }
  }

  return first
}

/** Serializes a `ParsedGradient` back into a CSS `background-image` value. */
export function serializeGradient(gradient: ParsedGradient): string {
  const args: string[] = []

  if (gradient.kind === 'linear' && gradient.direction) {
    args.push(gradient.direction.kind === 'angle' ? gradient.direction.raw : gradient.direction.keyword)
  }
  if (gradient.kind === 'radial' && gradient.shape) {
    args.push(gradient.shape)
  }

  const stopsText = gradient.stops
    .map((stop) => (stop.position != null ? `${stop.color} ${stop.position}%` : stop.color))
    .join(', ')
  args.push(stopsText)

  const fnName = gradient.kind === 'linear' ? 'linear-gradient' : 'radial-gradient'
  return `${fnName}(${args.join(', ')})`
}

/** True when `value` is a `url(...)` reference — the OTHER supported `backgroundImage` shape, handled by the image-mode editor instead of the gradient stops editor. */
export function isUrlImageValue(value: string): boolean {
  return /^url\s*\(/i.test(value.trim())
}

/** Extracts the payload of a `url('x')` / `url("x")` / `url(x)` expression, or `''` when `value` isn't a single `url(...)` call. */
export function extractUrlPayload(value: string): string {
  const match = value.trim().match(/^url\(\s*(['"]?)([^'")]+)\1\s*\)\s*$/i)
  return match?.[2]?.trim() ?? ''
}

/** Wraps a plain URL payload into the canonical single-quoted `url('x')` storage form. */
export function wrapUrlPayload(payload: string): string {
  const cleaned = payload.trim()
  if (!cleaned) return ''
  return `url('${cleaned.replace(/^['"]|['"]$/g, '')}')`
}
