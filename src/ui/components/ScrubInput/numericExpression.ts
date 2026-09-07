/**
 * numericExpression — the ONE evaluator behind "type maths into a number
 * field" (`100/2`, `100 + 8`, `100*2`, `(80+20)/2`).
 *
 * Figma's inspector fields accept arithmetic; ours accepted a bare number and
 * nothing else, in three places that each re-implemented "is this a number"
 * with their own regex (`scrubMath.parseScrubValue`,
 * `numericNudge.parseNudgeableValue`, `tokenUtils.resolveTokenValue`). This
 * module is the single parser all three now share, so a field that scrubs
 * also nudges and also does maths — one model, not three.
 *
 * WHAT IT ACCEPTS
 * ---------------
 *   <expr>   := <term> (('+' | '-') <term>)*
 *   <term>   := <unary> (('*' | '/') <unary>)*
 *   <unary>  := ('+' | '-')? <unary> | <primary>
 *   <primary>:= <number><unit?> | '(' <expr> ')'
 *
 * `<unit>` is a CSS unit or `%`. AT MOST ONE distinct unit may appear across
 * the whole expression, and it is the unit of the result: `100px + 8` is
 * `108px`, `100/2` is a bare `50` (the caller supplies its field's unit), and
 * `100px + 8em` is REFUSED — silently picking one of two units would be a
 * lying control, and this repo's second invariant forbids it. Division by
 * zero, a non-finite result, and any token outside the grammar (`calc(…)`,
 * `var(…)`, `auto`, `10px 20px`) are refused the same way, by returning
 * `null` so the caller keeps the user's literal text.
 *
 * TypeBox guards the exit: a parser is a boundary (CLAUDE.md), so the result
 * is validated against `NumericExpressionSchema` before it leaves — the
 * schema, not a parallel `interface`, is the source of truth for the shape.
 */

import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'

export const NumericExpressionSchema = Type.Object({
  /** The evaluated number. Always finite. */
  magnitude: Type.Number(),
  /** The single unit seen in the expression (`'px'`, `'%'`, `'deg'`), or `''` when it was unitless. */
  unit: Type.String(),
})

export type NumericExpression = Static<typeof NumericExpressionSchema>

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'number'; value: number; unit: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' }
  | { kind: 'paren'; value: '(' | ')' }

/** `12`, `.5`, `1.25rem`, `50%` — a magnitude plus at most one unit suffix. */
const NUMBER_RE = /^(\d*\.?\d+)([a-z%]*)/i

function tokenize(raw: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < raw.length) {
    const char = raw[i]!
    if (/\s/.test(char)) {
      i += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', value: char })
      i += 1
      continue
    }
    if (char === '+' || char === '-' || char === '*' || char === '/') {
      tokens.push({ kind: 'op', value: char })
      i += 1
      continue
    }
    const match = NUMBER_RE.exec(raw.slice(i))
    if (!match) return null
    const value = Number.parseFloat(match[1]!)
    if (!Number.isFinite(value)) return null
    tokens.push({ kind: 'number', value, unit: match[2] ?? '' })
    i += match[0]!.length
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Recursive-descent parser + evaluator
//
// Units ride along in `units`: every unit token seen is added, and more than
// one distinct entry at the end refuses the whole expression (see module doc).
// ---------------------------------------------------------------------------

interface ParserState {
  tokens: Token[]
  index: number
  units: Set<string>
  failed: boolean
}

function peek(state: ParserState): Token | undefined {
  return state.tokens[state.index]
}

function parseExpression(state: ParserState): number {
  let left = parseTerm(state)
  for (;;) {
    const token = peek(state)
    if (!token || token.kind !== 'op' || (token.value !== '+' && token.value !== '-')) break
    state.index += 1
    const right = parseTerm(state)
    left = token.value === '+' ? left + right : left - right
  }
  return left
}

function parseTerm(state: ParserState): number {
  let left = parseUnary(state)
  for (;;) {
    const token = peek(state)
    if (!token || token.kind !== 'op' || (token.value !== '*' && token.value !== '/')) break
    state.index += 1
    const right = parseUnary(state)
    if (token.value === '*') {
      left = left * right
    } else {
      // Division by zero yields Infinity/NaN — refused rather than written.
      if (right === 0) state.failed = true
      left = left / right
    }
  }
  return left
}

function parseUnary(state: ParserState): number {
  const token = peek(state)
  if (token && token.kind === 'op' && (token.value === '+' || token.value === '-')) {
    state.index += 1
    const operand = parseUnary(state)
    return token.value === '-' ? -operand : operand
  }
  return parsePrimary(state)
}

function parsePrimary(state: ParserState): number {
  const token = peek(state)
  if (!token) {
    state.failed = true
    return 0
  }
  if (token.kind === 'number') {
    state.index += 1
    if (token.unit !== '') state.units.add(token.unit.toLowerCase())
    return token.value
  }
  if (token.kind === 'paren' && token.value === '(') {
    state.index += 1
    const inner = parseExpression(state)
    const close = peek(state)
    if (!close || close.kind !== 'paren' || close.value !== ')') {
      state.failed = true
      return inner
    }
    state.index += 1
    return inner
  }
  state.failed = true
  return 0
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Evaluate a field's typed text into a magnitude + unit, or `null` when it
 * is not arithmetic this module can honestly reduce (see the module doc for
 * the full refusal list). A plain `120px` evaluates to itself, so callers
 * never need a separate "is it just a number" path.
 */
export function evaluateNumericExpression(raw: string): NumericExpression | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const tokens = tokenize(trimmed)
  if (!tokens || tokens.length === 0) return null

  const state: ParserState = { tokens, index: 0, units: new Set(), failed: false }
  const magnitude = parseExpression(state)
  if (state.failed || state.index !== tokens.length) return null
  if (state.units.size > 1) return null
  if (!Number.isFinite(magnitude)) return null

  // Round away binary-float dust (`0.1 + 0.2`) before it reaches the user's
  // stylesheet. Four decimals covers the 0.1 fine nudge with room to spare.
  const result = {
    magnitude: Number(magnitude.toFixed(4)),
    unit: [...state.units][0] ?? '',
  }

  const checked = safeParseValue(NumericExpressionSchema, result)
  return checked.ok ? checked.value : null
}

/**
 * Evaluate `raw` and render it back as a CSS value string, applying
 * `fallbackUnit` when the expression carried no unit of its own. Returns
 * `null` when `raw` is not evaluable — callers keep the literal text in that
 * case, exactly as they did before maths existed.
 *
 * `fallbackUnit: ''` means "this field is unitless" (a frame's pixel count, a
 * ratio) and a bare number stays bare.
 */
export function formatNumericExpression(raw: string, fallbackUnit: string): string | null {
  const evaluated = evaluateNumericExpression(raw)
  if (!evaluated) return null
  return `${evaluated.magnitude}${evaluated.unit || fallbackUnit}`
}
