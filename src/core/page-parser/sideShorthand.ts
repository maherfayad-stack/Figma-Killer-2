/**
 * sideShorthand — read an inline `padding` / `margin` shorthand back into the
 * per-side keys the property bag actually stores.
 *
 * The bag is per-side ONLY (`cssPropertyBag.ts`), and the inspector's writes
 * collapse four equal-or-paired sides into ONE shorthand declaration
 * (`sideShorthandWrites.ts`). Reading that source back has to be the inverse,
 * otherwise a reload leaves the four fields empty and showing the element's
 * computed values as muted placeholders. Class rules already get this from the
 * CSS engine's longhand unrolling; this is the same unrolling for an inline
 * `style={{ padding: '12px 20px' }}` literal.
 */

const BOXES = ['padding', 'margin'] as const
const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const

export type SideShorthandBox = (typeof BOXES)[number]

export function isSideShorthandKey(key: string): key is SideShorthandBox {
  return (BOXES as readonly string[]).includes(key)
}

/** Whitespace-split at the top level only — `calc(1px + 2px)` stays one token. */
function splitTopLevel(value: string): string[] {
  const tokens: string[] = []
  let depth = 0
  let current = ''
  for (const char of value.trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (/\s/.test(char) && depth === 0) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

/**
 * `padding: 12px 20px` -> `{ paddingTop: '12px', paddingRight: '20px', paddingBottom: '12px', paddingLeft: '20px' }`
 * (CSS 1-to-4 value rule). `undefined` for anything that is not a plain 1-4
 * value list — a CSS-wide keyword, `!important`, an unbalanced expression —
 * so the caller keeps the raw declaration instead of inventing sides.
 */
export function expandSideShorthand(box: SideShorthandBox, value: string | number): Record<string, string | number> | undefined {
  if (typeof value === 'number') {
    return Object.fromEntries(SIDES.map((side) => [`${box}${side}`, value]))
  }
  if (/!important/i.test(value)) return undefined
  const tokens = splitTopLevel(value)
  if (tokens.length < 1 || tokens.length > 4) return undefined
  if (tokens.length === 1 && /^(inherit|initial|unset|revert|revert-layer)$/i.test(tokens[0])) return undefined
  const [top, right = top, bottom = top, left = right] = tokens
  return {
    [`${box}Top`]: top,
    [`${box}Right`]: right,
    [`${box}Bottom`]: bottom,
    [`${box}Left`]: left,
  }
}
