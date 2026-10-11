/**
 * borderShorthand - reads a `border: <width> <style> <color>` declaration back
 * into the per-side width/style/color fields the Stroke section edits.
 *
 * Adding a stroke writes ONE `border: 1px solid #808080` (see
 * `studio/sideShorthandWrites.ts`), and a hand-written project is full of the
 * same declaration, so the section has to understand it: without this the row
 * that was just added would not appear, because the section reads only the
 * twelve longhands.
 *
 * Same posture as `borderRadiusShorthand.ts`: a value is split only when it can
 * be put back together without guessing. A token that fits no part leaves the
 * shorthand unexpanded, so the section shows nothing for it rather than a wrong
 * stroke.
 */
const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
const FIELDS = ['Width', 'Style', 'Color'] as const

const STYLE_KEYWORDS = new Set([
  'none',
  'hidden',
  'dotted',
  'dashed',
  'solid',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
])
const WIDTH_KEYWORDS = new Set(['thin', 'medium', 'thick'])
const WIDTH_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([a-z%]*)$/i

export interface BorderParts {
  width?: string
  style?: string
  color?: string
}

/** Split on whitespace that is not inside parentheses (`rgb(0 0 0 / 50%)` stays one token). */
function topLevelTokens(value: string): string[] {
  const tokens: string[] = []
  let depth = 0
  let current = ''
  for (const char of value.trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (/\s/.test(char) && depth === 0) {
      if (current !== '') tokens.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** `1px solid #808080` -> its three parts (any may be absent), or `null` when a token fits no part. */
export function parseBorderShorthand(value: string): BorderParts | null {
  const parts: BorderParts = {}
  for (const token of topLevelTokens(value)) {
    const lower = token.toLowerCase()
    if (STYLE_KEYWORDS.has(lower) && parts.style === undefined) parts.style = lower
    else if ((WIDTH_KEYWORDS.has(lower) || WIDTH_PATTERN.test(token)) && parts.width === undefined) parts.width = token
    else if (parts.color === undefined && !/^(calc|min|max|clamp)\(/.test(lower)) parts.color = token
    else return null
  }
  return parts
}

/**
 * `stored` with the `border` shorthand spread onto every side's width / style /
 * color. A side's own longhand wins over the shorthand; a part the shorthand
 * omits takes its CSS initial value (`medium`, `none`, `currentcolor`).
 */
export function withBorderShorthandExpanded(stored: Record<string, unknown>): Record<string, unknown> {
  const shorthand = stored.border
  if (typeof shorthand !== 'string' || shorthand.trim() === '') return stored
  const parts = parseBorderShorthand(shorthand)
  if (parts === null) return stored
  const expanded: Record<string, unknown> = { ...stored }
  const byField = { Width: parts.width ?? 'medium', Style: parts.style ?? 'none', Color: parts.color ?? 'currentcolor' }
  for (const side of SIDES) {
    for (const field of FIELDS) {
      const key = `border${side}${field}`
      const existing = stored[key]
      if (existing === undefined || existing === null || existing === '') expanded[key] = byField[field]
    }
  }
  return expanded
}
