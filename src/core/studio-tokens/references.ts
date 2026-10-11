/**
 * references - where a project's source MENTIONS a custom property, as text.
 *
 * One definition shared by the three things that must agree on it: the usage
 * count the Variables panel shows (`scanTokenUsage`), the "is it safe to
 * remove" check, and rename (which rewrites exactly the mentions it counted).
 * A mention is the token's name (`--color-brand`) standing alone - not a piece
 * of a longer identifier (`--color-brand-2`, `block--modifier`). It is a
 * DECLARATION when a `:` follows (`--color-brand: #fff`), and a REFERENCE
 * otherwise: `var(--color-brand)`, Tailwind's `bg-[--color-brand]` /
 * `bg-(--color-brand)`, `style={{ '--color-brand': v }}`, a comment.
 *
 * Textual on purpose: the references live in CSS, TSX strings, template
 * literals and Tailwind arbitrary values, and a parser per language would
 * disagree about which of them count. Pure and browser-safe.
 */

const NAME_CHARS = 'A-Za-z0-9_-'

/** A custom property name not preceded or followed by another name character. */
const MENTION_SOURCE = `(?<![${NAME_CHARS}])--[${NAME_CHARS}]+`

const DECLARATION_TAIL_RE = /^\s*:(?!:)/

export interface TokenMention {
  readonly name: string
  /** Offset of the leading `--` in the text searched. */
  readonly index: number
  /** True when the name is being declared (`--x: value`), false when it is read or merely named. */
  readonly declaration: boolean
}

function isDeclarationAt(text: string, end: number): boolean {
  return DECLARATION_TAIL_RE.test(text.slice(end, end + 16))
}

/** Every mention of any custom property in `text`, in order. */
export function findTokenMentions(text: string): TokenMention[] {
  if (!text.includes('--')) return []
  const mentions: TokenMention[] = []
  for (const match of text.matchAll(new RegExp(MENTION_SOURCE, 'g'))) {
    const name = match[0]
    mentions.push({ name, index: match.index, declaration: isDeclarationAt(text, match.index + name.length) })
  }
  return mentions
}

/**
 * Rewrite mentions of custom properties. `decide` returns the replacement name,
 * or `null` to leave that mention alone; every other byte is untouched.
 */
export function rewriteTokenMentions(
  text: string,
  decide: (mention: TokenMention) => string | null,
): { text: string; count: number } {
  if (!text.includes('--')) return { text, count: 0 }
  let count = 0
  const next = text.replace(new RegExp(MENTION_SOURCE, 'g'), (name: string, offset: number) => {
    const replacement = decide({ name, index: offset, declaration: isDeclarationAt(text, offset + name.length) })
    if (replacement === null || replacement === name) return name
    count++
    return replacement
  })
  return { text: next, count }
}
