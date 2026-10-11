/**
 * shorthandCoverage — which CSS shorthands reset which longhands, and how one
 * longhand's new value is spelled INSIDE the shorthand that sets it
 * (`expandShorthandSide`, G-5's "a shorthand is expanded in place").
 *
 * Pure text in, text out: no postcss, no ts-morph. Both style writers read it —
 * `setDeclaration` for a `.css` file and `setStyledDeclaration` for a
 * styled-component template — so "does `padding` cover `padding-top`" has one
 * answer in the repo.
 *
 * ## Coverage is a table, and an incomplete table is a miss, never a corruption
 *
 * Not an exhaustive model of the CSS spec, and deliberately so: the table only
 * needs the shorthands that realistically appear in a hand-authored stylesheet
 * beside a longhand the inspector can emit. A shorthand missing from here
 * degrades to a plain append (the new longhand lands LAST, where it wins) rather
 * than to a wrong write.
 *
 * ## Expansion is for the one case an append cannot honestly cover
 *
 * A non-`!important` shorthand needs no rewrite: the longhand is written right
 * after it and wins by order. A covering `!important` shorthand beats a plain
 * longhand from ANY position, so the honest spellings are (1) the same
 * declaration with that one side changed — which keeps the author's single
 * `!important` — or, when the shorthand's value cannot be read side by side
 * (`var()` of unknown arity, a comment inside the value, a `/` in a radius), (2)
 * a longhand that carries its own `!important`. This module answers (1); a
 * `null` here is the caller's cue for (2).
 */

/** Which longhands a shorthand resets. */
const SHORTHAND_COVERAGE: ReadonlyArray<readonly [shorthand: string, covers: RegExp]> = [
  ['margin', /^margin-(top|right|bottom|left)$/],
  ['padding', /^padding-(top|right|bottom|left)$/],
  ['inset', /^(top|right|bottom|left)$/],
  ['gap', /^(row|column)-gap$/],
  ['overflow', /^overflow-(x|y)$/],
  ['background', /^background-[a-z-]+$/],
  ['font', /^font-(family|size|style|weight|variant)$|^line-height$/],
  ['border', /^border-(top|right|bottom|left|width|style|color)(-[a-z]+)?$/],
  ['border-radius', /^border-(top|bottom)-(left|right)-radius$/],
  ['border-width', /^border-(top|right|bottom|left)-width$/],
  ['border-style', /^border-(top|right|bottom|left)-style$/],
  ['border-color', /^border-(top|right|bottom|left)-color$/],
  ['flex', /^flex-(grow|shrink|basis)$/],
  ['flex-flow', /^flex-(direction|wrap)$/],
  ['place-items', /^(align|justify)-items$/],
  ['place-content', /^(align|justify)-content$/],
  ['transition', /^transition-[a-z-]+$/],
  ['animation', /^animation-[a-z-]+$/],
  ['list-style', /^list-style-[a-z-]+$/],
  ['outline', /^outline-[a-z-]+$/],
  ['grid-area', /^grid-(row|column)(-(start|end))?$/],
]

/** True when setting `longhand` would be reset by a declaration of `shorthand`. */
export function shorthandCovers(shorthand: string, longhand: string): boolean {
  if (shorthand === longhand) return false
  for (const [name, covers] of SHORTHAND_COVERAGE) {
    if (name === shorthand && covers.test(longhand)) return true
  }
  return false
}

/**
 * The shorthands whose value is a plain 1-4 (or 1-2) token list, with the
 * longhand each slot sets. Box shorthands run top, right, bottom, left; radius
 * runs top-left, top-right, bottom-right, bottom-left; a pair runs first,
 * second.
 */
const EXPANDABLE: Readonly<Record<string, readonly string[]>> = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
}

/** Top-level whitespace-separated tokens of a value — a parenthesis or a quote keeps its contents whole. */
function splitTokens(value: string): string[] | null {
  const tokens: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (const char of value.trim()) {
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (depth < 0) return null
    if (/\s/.test(char) && depth === 0) {
      if (current.length > 0) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (depth !== 0 || quote !== null) return null
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** A token whose arity the author may have hidden: `var(--pad)` can stand for `8px 16px`. */
function hidesArity(token: string): boolean {
  return /^(var|env|attr)\(/i.test(token)
}

/** The four slots a 1-4 token box value stands for, in top/right/bottom/left order. */
function boxSlots(tokens: readonly string[]): [string, string, string, string] | null {
  const [a, b, c, d] = tokens
  switch (tokens.length) {
    case 1:
      return [a!, a!, a!, a!]
    case 2:
      return [a!, b!, a!, b!]
    case 3:
      return [a!, b!, c!, b!]
    case 4:
      return [a!, b!, c!, d!]
    default:
      return null
  }
}

/** The fewest tokens, no fewer than `atLeast`, that still spell these four slots. */
function spellBox(slots: readonly [string, string, string, string], atLeast: number): string {
  const [t, r, b, l] = slots
  const fits = (count: number): boolean => {
    if (count === 1) return t === r && r === b && b === l
    if (count === 2) return t === b && r === l
    if (count === 3) return r === l
    return true
  }
  for (let count = Math.max(1, atLeast); count <= 4; count += 1) {
    if (fits(count)) return [t, r, b, l].slice(0, count).join(' ')
  }
  return slots.join(' ')
}

/**
 * `shorthand: shorthandValue` with the slot `longhand` sets replaced by
 * `newValue` — the same declaration, one side changed — or `null` when that
 * cannot be spelled without guessing (an unknown shorthand, a value that hides
 * its arity behind `var()`, a radius with a `/`, a multi-token `newValue`).
 * Slots the edit did not touch keep their tokens; the token COUNT only grows
 * when the edit needs it (`padding: 8px` + a new top is `12px 8px 8px`).
 */
export function expandShorthandSide(
  shorthand: string,
  shorthandValue: string,
  longhand: string,
  newValue: string,
): string | null {
  const slotsOf = EXPANDABLE[shorthand.toLowerCase()]
  if (!slotsOf) return null
  const index = slotsOf.indexOf(longhand.toLowerCase())
  if (index < 0) return null
  if (shorthandValue.includes('/') || shorthandValue.includes('/*')) return null

  const tokens = splitTokens(shorthandValue)
  const fresh = splitTokens(newValue)
  if (tokens === null || fresh === null || fresh.length !== 1) return null
  if (tokens.some(hidesArity) || hidesArity(fresh[0]!)) return null

  if (slotsOf.length === 2) {
    if (tokens.length < 1 || tokens.length > 2) return null
    const pair: [string, string] = [tokens[0]!, tokens[1] ?? tokens[0]!]
    pair[index] = fresh[0]!
    return pair[0] === pair[1] && tokens.length === 1 ? pair[0] : pair.join(' ')
  }

  const slots = boxSlots(tokens)
  if (slots === null) return null
  slots[index] = fresh[0]!
  return spellBox(slots, tokens.length)
}
