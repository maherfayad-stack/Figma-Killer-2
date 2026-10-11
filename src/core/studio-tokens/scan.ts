/**
 * scan — EVERY custom-property declaration in a stylesheet, each with the gate
 * (mode) it is declared under.
 *
 * `server/handlers/studio/tokenExtractCssScan.ts`'s `collectRootScopeDeclarations`
 * answers "which declaration wins for light, which for dark" and drops the
 * rest. A token catalog with modes needs the rest: the `[data-density=compact]`
 * value, the `:lang(ar)` value, the width-`@media` override, the component's
 * own `--btn-pad`. This is the same walk without the winner-picking.
 *
 * Pure text in, no postcss (the editor loads it for the framework scales), never
 * throws. Offsets index into the scanned text so a caller can turn them into
 * `file:line`.
 */
import { classifyGates, type ModeGate } from './gates'
import { scanRulesAtOneLevel } from './ruleScan'

export interface GatedDeclaration {
  /** Property name with the leading dashes. */
  readonly name: `--${string}`
  /** The value as written, trimmed (may carry `!important`). */
  readonly raw: string
  /** Offset of the name's first character in the scanned text. */
  readonly offset: number
  /** The rule's selector, or `null` for a declaration that sits straight in an at-rule (`@theme`). */
  readonly selector: string | null
  /** Enclosing at-rules, outermost first, as `@name params`. */
  readonly atRules: readonly string[]
  /** The mode this declaration belongs to — one declaration per selector segment of a comma group. */
  readonly gate: ModeGate
  /** Declared inside Tailwind v4's `@theme` (so it also generates utilities). */
  readonly inTheme: boolean
}

/** At-rules whose body is rules we descend into; anything else (`@keyframes`, `@font-face`, `@property`) declares no tokens. */
const DESCENDABLE_AT_RULE_RE = /^@(?:layer|media|supports|container|scope|starting-style)\b/i
const THEME_AT_RULE_RE = /^@theme\b/i
const MAX_AT_RULE_DEPTH = 32
const NAME_RE = /^(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]*)$/

interface Segment {
  readonly text: string
  readonly offset: number
}

/**
 * The `name: value` segments that sit DIRECTLY in `body` — not those inside a
 * nested block (a nested rule's own declarations belong to that rule). Quotes,
 * parentheses (`url(a;b)`) and comments do not end a segment.
 */
function topLevelSegments(body: string, baseOffset: number): Segment[] {
  const segments: Segment[] = []
  let depth = 0
  let parens = 0
  let quote: string | null = null
  let start = 0
  const flush = (end: number): void => {
    if (depth === 0) {
      const text = body.slice(start, end)
      if (text.trim().length > 0) segments.push({ text, offset: baseOffset + start })
    }
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2)
      // A comment inside a segment is blanked, not removed, so offsets stay true.
      const stop = end === -1 ? body.length : end + 2
      body = body.slice(0, i) + ' '.repeat(stop - i) + body.slice(stop)
      i = stop - 1
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') parens++
    else if (ch === ')') parens = Math.max(0, parens - 1)
    else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1)
      if (depth === 0) start = i + 1
    } else if (ch === ';' && parens === 0) {
      flush(i)
      start = i + 1
    }
  }
  flush(body.length)
  return segments
}

function collect(
  css: string,
  baseOffset: number,
  depth: number,
  atRules: readonly string[],
  into: GatedDeclaration[],
): void {
  if (depth > MAX_AT_RULE_DEPTH) return
  for (const rule of scanRulesAtOneLevel(css)) {
    const bodyOffset = baseOffset + rule.bodyOffset
    if (rule.selector.startsWith('@')) {
      const prelude = rule.selector.replace(/\s+/g, ' ').trim()
      if (THEME_AT_RULE_RE.test(prelude)) {
        pushDeclarations(rule.body, bodyOffset, null, [...atRules, prelude], true, into)
      } else if (DESCENDABLE_AT_RULE_RE.test(prelude)) {
        collect(rule.body, bodyOffset, depth + 1, [...atRules, prelude], into)
      }
      continue
    }
    pushDeclarations(rule.body, bodyOffset, rule.selector.replace(/\s+/g, ' ').trim(), atRules, false, into)
  }
}

function pushDeclarations(
  body: string,
  bodyOffset: number,
  selector: string | null,
  atRules: readonly string[],
  inTheme: boolean,
  into: GatedDeclaration[],
): void {
  const gates = classifyGates(selector, atRules)
  for (const segment of topLevelSegments(body, bodyOffset)) {
    const leading = segment.text.length - segment.text.trimStart().length
    const match = NAME_RE.exec(segment.text.trimStart())
    if (!match) continue
    const raw = match[2]!.trim()
    if (raw.length === 0) continue
    for (const gate of gates) {
      into.push({
        name: match[1] as `--${string}`,
        raw,
        offset: segment.offset + leading,
        selector,
        atRules,
        gate,
        inTheme,
      })
    }
  }
}

/** Every custom-property declaration in `css`, in source order. */
export function scanGatedDeclarations(css: string): GatedDeclaration[] {
  const found: GatedDeclaration[] = []
  collect(css, 0, 0, [], found)
  return found
}

/** 1-based line of `offset` in `text`. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}
