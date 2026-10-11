/**
 * variantRule — clone one top-level CSS rule under a new selector, or take one
 * out, as a byte-exact splice of the stylesheet's own text. The write behind a
 * variant whose styling is a class (`.ghost`, `.btn-ghost`) or a data-attribute
 * selector (`[data-variant="ghost"]`) in a stylesheet the component imports.
 *
 * postcss only LOCATES (every untouched byte round-trips verbatim); the new
 * rule is the original rule's own text with its selector rewritten, placed
 * right after it with the blank-line gap the file already uses between rules.
 * Nothing is reformatted, no declaration is re-ordered, and a copy keeps its
 * comments and its trailing semicolon habit.
 *
 * Scope, deliberately narrow: a top-level rule, found by where it starts. A
 * rule inside `@media`, a state rule (`.ghost:hover`) and a rule in SCSS/Less
 * syntax postcss cannot parse are not reached; the variant analyzer never
 * claims them either. The caller supplies the selector rewrite, so this module
 * knows nothing about classes versus attributes beyond the two small rewriters
 * exported below.
 *
 * Text is LF-normalised by the caller. Pure strings in, a splice out.
 */
import postcss, { type Root, type Rule } from 'postcss'
import type { TextSplice } from '@core/utils/textSplice'

export type VariantRuleRefusalReason = 'stale-source' | 'selector-unchanged' | 'unparseable'

export interface VariantRuleRefusal {
  reason: VariantRuleRefusalReason
  message: string
}

export type CloneRuleResult =
  | { ok: true; splice: TextSplice; existed: false }
  /** A rule with the new selector already exists in this stylesheet; there is nothing to copy. */
  | { ok: true; splice: null; existed: true }
  | { ok: false; refusal: VariantRuleRefusal }

export type RemoveRuleResult = { ok: true; splice: TextSplice } | { ok: false; refusal: VariantRuleRefusal }

function refuse(reason: VariantRuleRefusalReason, message: string): { ok: false; refusal: VariantRuleRefusal } {
  return { ok: false, refusal: { reason, message } }
}

function parse(css: string): Root | null {
  try {
    return postcss.parse(css)
  } catch (_err) {
    // Not plain CSS (SCSS/Less syntax): the caller refuses, naming this.
    return null
  }
}

/** The top-level rule starting at the 1-based position, or `undefined`. */
function ruleAt(root: Root, line: number, column: number): Rule | undefined {
  let found: Rule | undefined
  root.each((node) => {
    if (node.type === 'rule' && node.source?.start?.line === line && node.source.start.column === column) found = node
  })
  return found
}

const NOT_FOUND = (selector: string): VariantRuleRefusal => ({
  reason: 'stale-source',
  message: `The stylesheet changed since it was read: the rule \`${selector}\` is no longer where it was.`,
})

/** postcss's `end.offset` is already exclusive: `css.slice(start, end)` is the whole node. */
function endOffset(node: { source?: { end?: { offset: number } } }): number | null {
  return node.source?.end?.offset ?? null
}

function startOffset(node: { source?: { start?: { offset: number } } }): number | null {
  return node.source?.start?.offset ?? null
}

function normalizedSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim()
}

/** The splice that inserts a copy of the rule starting at `line`:`column`, its selector passed through `rewrite`, right after it. */
export function cloneRule(
  css: string,
  at: { line: number; column: number; selector: string },
  rewrite: (selector: string) => string,
): CloneRuleResult {
  const root = parse(css)
  if (!root) return refuse('unparseable', 'This stylesheet is not plain CSS (Sass/Less syntax), so a rule cannot be copied safely.')
  const rule = ruleAt(root, at.line, at.column)
  const start = rule ? startOffset(rule) : null
  const end = rule ? endOffset(rule) : null
  if (!rule || start === null || end === null) return refuse('stale-source', NOT_FOUND(at.selector).message)

  const selectorRaw = rule.raws.selector?.raw ?? rule.selector
  if (css.slice(start, start + selectorRaw.length) !== selectorRaw) return refuse('stale-source', NOT_FOUND(at.selector).message)
  const nextSelector = rewrite(selectorRaw)
  if (nextSelector === selectorRaw) return refuse('selector-unchanged', `The copy of \`${at.selector}\` would have the same selector.`)

  const wanted = normalizedSelector(nextSelector)
  let existed = false
  root.each((node) => {
    if (node.type === 'rule' && normalizedSelector(node.selector) === wanted) existed = true
  })
  if (existed) return { ok: true, splice: null, existed: true }

  const next = rule.next()
  const gapRaw = next?.raws.before
  const gap = gapRaw !== undefined && /^\s*$/.test(gapRaw) && gapRaw.includes('\n') ? gapRaw : '\n\n'
  const copy = nextSelector + css.slice(start + selectorRaw.length, end)
  return { ok: true, splice: { offset: end, deleteLength: 0, insert: gap + copy }, existed: false }
}

/** The splice that removes the rule starting at `line`:`column` together with the blank gap that separated it from its neighbour. */
export function removeRule(css: string, at: { line: number; column: number; selector: string }): RemoveRuleResult {
  const root = parse(css)
  if (!root) return refuse('unparseable', 'This stylesheet is not plain CSS (Sass/Less syntax), so a rule cannot be removed safely.')
  const rule = ruleAt(root, at.line, at.column)
  const start = rule ? startOffset(rule) : null
  const end = rule ? endOffset(rule) : null
  if (!rule || start === null || end === null) return refuse('stale-source', NOT_FOUND(at.selector).message)
  if (normalizedSelector(rule.selector) !== normalizedSelector(at.selector)) return refuse('stale-source', NOT_FOUND(at.selector).message)

  const previous = rule.prev()
  const previousEnd = previous ? endOffset(previous) : null
  const next = rule.next()
  const nextStart = next ? startOffset(next) : null
  let splice: TextSplice
  if (previousEnd !== null) splice = { offset: previousEnd, deleteLength: end - previousEnd, insert: '' }
  else if (nextStart !== null) splice = { offset: start, deleteLength: nextStart - start, insert: '' }
  else splice = { offset: start, deleteLength: end - start, insert: '' }

  const candidate = css.slice(0, splice.offset) + css.slice(splice.offset + splice.deleteLength)
  return parse(candidate) ? { ok: true, splice } : refuse('unparseable', 'Removing that rule would leave this stylesheet unparseable.')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches what a class rewrite must leave alone: attribute selectors and quoted strings. */
const UNTOUCHABLE = /\[[^\]]*\]|"[^"]*"|'[^']*'/g

/** `.from` -> `.to` wherever it is a whole class name in `selector` (`.btn.from` included; `[href$=".from"]` is not a class). */
export function rewriteClassSelector(selector: string, from: string, to: string): string {
  const pattern = new RegExp(`\\.${escapeRegExp(from)}(?![\\w-])`, 'g')
  let result = ''
  let last = 0
  for (const protectedPart of selector.matchAll(UNTOUCHABLE)) {
    result += selector.slice(last, protectedPart.index).replace(pattern, `.${to}`) + protectedPart[0]
    last = protectedPart.index + protectedPart[0].length
  }
  return result + selector.slice(last).replace(pattern, `.${to}`)
}

/** `[attr="from"]` -> `[attr="to"]`, keeping the attribute selector's own spacing and quote. */
export function rewriteAttributeSelector(selector: string, attr: string, from: string, to: string): string {
  const pattern = new RegExp(`\\[(\\s*${escapeRegExp(attr)}\\s*=\\s*)(["']?)${escapeRegExp(from)}\\2(\\s*)\\]`, 'g')
  return selector.replace(pattern, (_match, head: string, quote: string, tail: string) => `[${head}${quote}${to}${quote}${tail}]`)
}
