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
 * Scope, deliberately narrow: a top-level rule, found by where it starts, and
 * its STATE rules: the top-level rules whose every selector is the member's
 * selector plus pseudo-classes/elements (`.ghost:hover`,
 * `.ghost:not(:disabled):focus-visible`, `.ghost::before`). They travel with the
 * member (copied beside the copy, removed with the original), because a variant
 * without its hover state is a different variant. A rule inside `@media`, a
 * descendant rule (`.ghost .icon`) and a rule in SCSS/Less syntax postcss
 * cannot parse are not reached; the variant analyzer never claims them either.
 * The caller supplies the selector rewrite, so this module knows nothing about
 * classes versus attributes beyond the two small rewriters exported below.
 *
 * Text is LF-normalised by the caller. Pure strings in, a splice out.
 */
import postcss, { type ChildNode, type Root, type Rule } from 'postcss'
import { applyTextSplices, type TextSplice } from '@core/utils/textSplice'

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

export type RemoveRuleResult = { ok: true; splices: TextSplice[] } | { ok: false; refusal: VariantRuleRefusal }

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
  message: `The rule \`${selector}\` is no longer where the board read it. Reload the project and try again.`,
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

/** One or more pseudo-classes / pseudo-elements, each with at most one level of nested parentheses (`:not(:disabled)`). */
const PSEUDO_TAIL = /^(?:::?[A-Za-z][\w-]*(?:\((?:[^()]|\([^()]*\))*\))?)+$/

/** Whether `selector` is `member` plus only pseudo-classes / pseudo-elements. */
function isStateOf(selector: string, member: string): boolean {
  const normalized = normalizedSelector(selector)
  return normalized.length > member.length && normalized.startsWith(member) && PSEUDO_TAIL.test(normalized.slice(member.length))
}

/**
 * The top-level rules that are states of `rule`: every one of their selectors is
 * a state of one of `rule`'s own. In document order, `rule` itself excluded.
 */
function stateRulesOf(root: Root, rule: Rule): Rule[] {
  const members = rule.selectors.map(normalizedSelector)
  const states: Rule[] = []
  root.each((node) => {
    if (node.type !== 'rule' || node === rule) return
    if (node.selectors.every((selector) => members.some((member) => isStateOf(selector, member)))) states.push(node)
  })
  return states
}

/**
 * The splice that inserts a copy of the rule starting at `line`:`column`, its
 * selector passed through `rewrite`, right after it, followed by a copy of each
 * of its state rules (`.ghost:hover`) under the rewritten selector. A state
 * rule whose copy already exists is skipped.
 */
export function cloneRule(
  css: string,
  at: { line: number; column: number; selector: string },
  rewrite: (selector: string) => string,
): CloneRuleResult {
  const root = parse(css)
  if (!root) return refuse('unparseable', 'This stylesheet is not plain CSS (Sass or Less syntax), so a rule cannot be copied safely. Copy the rule in the code.')
  const rule = ruleAt(root, at.line, at.column)
  const start = rule ? startOffset(rule) : null
  const end = rule ? endOffset(rule) : null
  if (!rule || start === null || end === null) return refuse('stale-source', NOT_FOUND(at.selector).message)

  const selectorRaw = rule.raws.selector?.raw ?? rule.selector
  if (css.slice(start, start + selectorRaw.length) !== selectorRaw) return refuse('stale-source', NOT_FOUND(at.selector).message)
  const nextSelector = rewrite(selectorRaw)
  if (nextSelector === selectorRaw) return refuse('selector-unchanged', `The copy of \`${at.selector}\` would have the same selector. Give the copy a different selector.`)

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
  let insert = gap + copy
  for (const state of stateRulesOf(root, rule)) {
    const stateStart = startOffset(state)
    const stateEnd = endOffset(state)
    const stateRaw = state.raws.selector?.raw ?? state.selector
    if (stateStart === null || stateEnd === null || css.slice(stateStart, stateStart + stateRaw.length) !== stateRaw) continue
    const stateNext = rewrite(stateRaw)
    const taken = normalizedSelector(stateNext)
    let stateExisted = false
    root.each((node) => {
      if (node.type === 'rule' && normalizedSelector(node.selector) === taken) stateExisted = true
    })
    if (stateNext === stateRaw || stateExisted) continue
    insert += gap + stateNext + css.slice(stateStart + stateRaw.length, stateEnd)
  }
  return { ok: true, splice: { offset: end, deleteLength: 0, insert }, existed: false }
}

/**
 * The splices that remove the rule starting at `line`:`column` and its state
 * rules, each run of removed neighbours together with the blank gap that
 * separated it from the rule before it (or after it, for the first in the file).
 */
export function removeRule(css: string, at: { line: number; column: number; selector: string }): RemoveRuleResult {
  const root = parse(css)
  if (!root) return refuse('unparseable', 'This stylesheet is not plain CSS (Sass or Less syntax), so a rule cannot be removed safely. Remove the rule in the code.')
  const rule = ruleAt(root, at.line, at.column)
  const start = rule ? startOffset(rule) : null
  const end = rule ? endOffset(rule) : null
  if (!rule || start === null || end === null) return refuse('stale-source', NOT_FOUND(at.selector).message)
  if (normalizedSelector(rule.selector) !== normalizedSelector(at.selector)) return refuse('stale-source', NOT_FOUND(at.selector).message)

  const doomed = new Set<ChildNode>([rule, ...stateRulesOf(root, rule)])
  const splices: TextSplice[] = []
  for (let node: ChildNode | undefined = root.first; node; ) {
    if (!doomed.has(node)) {
      node = node.next()
      continue
    }
    // A maximal run of consecutive doomed siblings goes as ONE splice, so two neighbours never overlap.
    let last: ChildNode = node
    for (let following = last.next(); following && doomed.has(following); following = last.next()) last = following
    const previous = node.prev()
    const following = last.next()
    const runStart = startOffset(node)
    const runEnd = endOffset(last)
    const previousEnd = previous ? endOffset(previous) : null
    const followingStart = following ? startOffset(following) : null
    if (runStart === null || runEnd === null) return refuse('stale-source', NOT_FOUND(at.selector).message)
    if (previousEnd !== null) splices.push({ offset: previousEnd, deleteLength: runEnd - previousEnd, insert: '' })
    else if (followingStart !== null) splices.push({ offset: runStart, deleteLength: followingStart - runStart, insert: '' })
    else splices.push({ offset: runStart, deleteLength: runEnd - runStart, insert: '' })
    node = following
  }

  return parse(applyTextSplices(css, splices))
    ? { ok: true, splices }
    : refuse('unparseable', 'Removing that rule would leave this stylesheet unparseable. Remove it in the code.')
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
