/**
 * studioPastedHtmlStyles - what happens to the CSS that came with a pasted
 * HTML fragment, and to the `class` tokens that point at it (G-10).
 *
 * Pure: it reads a tree, a stylesheet's text and two facts about the project
 * (where the page's stylesheet is, which class names are already taken), and
 * returns the rewritten tree plus the rules to write. `studioInsertHtml.ts`
 * does the I/O.
 *
 * ## Where a rule may go - exactly one honest target
 *
 * A pasted `<style>` is another site's CSS, and CSS reaches everywhere its
 * selector matches. Writing `.card { padding: 8px }` into the user's stylesheet
 * restyles every `.card` they already have; writing `a { color: red }` or
 * `body { margin: 0 }` restyles their whole app. So a rule is written only when
 * it is SCOPED TO THE PASTE:
 *
 *  - **its classes are the paste's own.** A class the paste uses and the
 *    project already has (as a rule, or as a token in any source file) is
 *    RENAMED (`.card` -> `.card-2`, in the rule and on the element) rather than
 *    merged into the existing rule. Nothing already on the board changes.
 *  - **every selector of the rule contains one of them**, as a class outside
 *    any `:not(...)`/`:is(...)`, and nothing after it reaches a sibling
 *    (`+` / `~`): `.hero a:hover` and `.hero > p` qualify, `a`, `*`, `:root`,
 *    `.hero + p` do not. A rule that does not qualify is SKIPPED AND REPORTED,
 *    never written.
 *  - an at-rule is written only as `@media` / `@supports` / `@container`
 *    around such rules. `@import`, `@font-face`, `@keyframes`, `@page`, `:root`
 *    custom properties and nested CSS are skipped and reported.
 *
 * Every declaration is checked with the CSS value sanitizer and the
 * external-resource predicate; one that fails is dropped and COUNTED.
 *
 * ## Which stylesheet, and how the elements reach it
 *
 *  - a plain `.css` the page imports: the rules go in, the elements keep
 *    `className="card-2"`;
 *  - a CSS Module the page imports with a default binding: the rules go in,
 *    and the element's class becomes the expression the page's other elements
 *    use (`className={styles.card}`, `` `${styles.card} lead` `` beside a
 *    literal);
 *  - no stylesheet the page imports: INLINE. A rule that is nothing but one
 *    class is resolved onto the elements that carry it, in stylesheet order,
 *    under the element's own `style`; that class token is then dropped from the
 *    element. Anything else cannot be pinned to an element and is reported.
 */
import postcss, { type AtRule, type ChildNode, type Rule } from 'postcss'
import { ClassNameTokens, type ClassNamePart, type InsertableJsxPropValue } from '@core/ast-codemods'
import { parseAtRuleScope } from '@core/css-codemods'
import { cssPropertyToStyleKey } from '@core/css-codemods/browser'
import { sanitiseCssValue } from '@core/css-sanitize'
import { cssValueLoadsExternalResource } from '@core/vector'
import type { PastedNode } from './studioPastedHtmlGuard'

export type StyleDestination =
  | { kind: 'global'; file: string }
  | { kind: 'module'; file: string; binding: string }

/** What the paste did with its CSS - shown to the user, so none of it is silent. */
export interface PastedHtmlSummary {
  /** The stylesheet the rules were written into (workspace-relative), or `null`. */
  stylesheet: string | null
  mode: 'module' | 'global' | 'inline' | 'none'
  /** Rules written into the stylesheet. */
  rules: number
  /** Rules resolved onto elements as inline style. */
  inlined: number
  /** Pasted classes renamed because the project already had that name. */
  renamed: { from: string; to: string }[]
  /** Selectors and at-rules that were not written. */
  skipped: string[]
  /** Declarations dropped by the CSS value sanitizer. */
  droppedDeclarations: number
}

export interface CssRuleWrite {
  selector: string
  declarations: Record<string, string>
  atRule?: string
}

/** A pasted node after planning: its `className` may now be a module expression. */
export interface PlannedNode {
  name: string
  props?: Record<string, InsertableJsxPropValue | undefined>
  children?: string | PlannedNode[]
}

export interface StylePlan {
  roots: PlannedNode[]
  writes: CssRuleWrite[]
  summary: Omit<PastedHtmlSummary, 'stylesheet'>
}

const MAX_REPORTED = 50
const FORBIDDEN_PROPERTIES = new Set(['behavior', '-moz-binding'])
const IDENT_START = /[A-Za-z_\\-]/
const SINGLE_CLASS = /^\.(-?[A-Za-z_][\w-]*)$/

interface ParsedRule {
  selectors: string[]
  declarations: { prop: string; value: string; important: boolean }[]
  atRule?: string
}

export function planPastedStyles(
  roots: readonly PastedNode[],
  css: string,
  destination: StyleDestination | null,
  taken: ReadonlySet<string>,
): StylePlan {
  const summary: StylePlan['summary'] = { mode: 'none', rules: 0, inlined: 0, renamed: [], skipped: [], droppedDeclarations: 0 }
  const tokens = new Set<string>()
  collectTokens(roots, tokens)

  const parsed = tokens.size > 0 && css.trim() ? parseRules(css, summary) : []
  const kept = parsed.map((rule) => ({ ...rule, declarations: cleanDeclarations(rule.declarations, summary) }))

  if (kept.length === 0 || tokens.size === 0) {
    return { roots: roots.map((node) => carry(node, (props) => props)), writes: [], summary }
  }
  return destination ? planIntoStylesheet(roots, kept, destination, taken, tokens, summary) : planInline(roots, kept, summary)
}

function note(summary: StylePlan['summary'], skipped: string): void {
  if (summary.skipped.length < MAX_REPORTED) summary.skipped.push(skipped)
}

// ---- parsing ---------------------------------------------------------------

function parseRules(css: string, summary: StylePlan['summary']): ParsedRule[] {
  let root: postcss.Root
  try {
    root = postcss.parse(css)
  } catch {
    note(summary, 'the stylesheet (it is not valid CSS)')
    return []
  }
  const rules: ParsedRule[] = []
  const take = (rule: Rule, atRule?: string): void => {
    if (rule.nodes.some((child: ChildNode) => child.type === 'rule' || child.type === 'atrule')) {
      note(summary, `${rule.selector} (nested CSS)`)
      return
    }
    const declarations = rule.nodes.flatMap((child) =>
      child.type === 'decl' ? [{ prop: child.prop, value: child.value, important: child.important === true }] : [],
    )
    rules.push({ selectors: rule.selectors.map((selector) => selector.trim().replace(/\s+/g, ' ')), declarations, ...(atRule ? { atRule } : {}) })
  }
  for (const node of root.nodes) {
    if (node.type === 'rule') take(node)
    else if (node.type === 'atrule') takeAtRule(node, take, summary)
  }
  return rules
}

function takeAtRule(node: AtRule, take: (rule: Rule, atRule?: string) => void, summary: StylePlan['summary']): void {
  const scope = `${node.name} ${node.params}`.trim()
  if (!['media', 'supports', 'container'].includes(node.name.toLowerCase()) || !parseAtRuleScope(scope)) {
    note(summary, `@${node.name}${node.params ? ` ${node.params}` : ''}`)
    return
  }
  for (const child of node.nodes ?? []) {
    if (child.type === 'rule') take(child, scope)
    else note(summary, `@${node.name} (${child.type === 'atrule' ? `@${child.name}` : 'a nested block'} inside it)`)
  }
}

/** Declarations that survive the value sanitizer; the rest are counted. */
function cleanDeclarations(declarations: ParsedRule['declarations'], summary: StylePlan['summary']): ParsedRule['declarations'] {
  return declarations.filter(({ prop, value }) => {
    const safe =
      !FORBIDDEN_PROPERTIES.has(prop.toLowerCase()) && sanitiseCssValue(value) !== null && !cssValueLoadsExternalResource(value)
    if (!safe) summary.droppedDeclarations += 1
    return safe
  })
}

// ---- selectors -------------------------------------------------------------

interface ClassSpan {
  start: number
  end: number
  /** The class as a token reads it: escapes removed. */
  name: string
  /** Paren nesting: `.a` in `:not(.a)` is depth 1. */
  depth: number
  /** Index of the compound (between combinators) the class sits in. */
  compound: number
}

interface ScannedSelector {
  classes: ClassSpan[]
  /** `combinators[i]` joins compound `i` to compound `i + 1`. */
  combinators: (' ' | '>' | '+' | '~')[]
}

function scanSelector(selector: string): ScannedSelector {
  const classes: ClassSpan[] = []
  const combinators: ScannedSelector['combinators'] = []
  let quote = ''
  let bracket = 0
  let paren = 0
  let compound = 0
  let i = 0
  while (i < selector.length) {
    const ch = selector[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[') bracket += 1
    else if (ch === ']') bracket = Math.max(0, bracket - 1)
    else if (bracket === 0 && ch === '(') paren += 1
    else if (bracket === 0 && ch === ')') paren = Math.max(0, paren - 1)
    else if (bracket === 0 && paren === 0 && /[\s>+~]/.test(ch)) {
      let end = i
      let kind: ScannedSelector['combinators'][number] = ' '
      while (end < selector.length && /[\s>+~]/.test(selector[end]!)) {
        const c = selector[end]!
        if (c === '>' || c === '+' || c === '~') kind = c
        end += 1
      }
      // A leading/trailing combinator run (`> p`) belongs to no compound pair.
      if (i > 0 && end < selector.length) {
        combinators.push(kind)
        compound += 1
      }
      i = end
      continue
    } else if (bracket === 0 && ch === '.' && IDENT_START.test(selector[i + 1] ?? '')) {
      let end = i + 1
      let name = ''
      while (end < selector.length) {
        const c = selector[end]!
        if (c === '\\') {
          name += selector[end + 1] ?? ''
          end += 2
        } else if (/[\w-]/.test(c) || c.charCodeAt(0) > 127) {
          name += c
          end += 1
        } else break
      }
      classes.push({ start: i, end, name, depth: paren, compound })
      i = end
      continue
    }
    i += 1
  }
  return { classes, combinators }
}

/** The pasted classes a rule names at depth 0, across all its selectors. */
function topLevelClasses(selectors: readonly string[]): Set<string> {
  return new Set(selectors.flatMap((selector) => scanSelector(selector).classes.filter((c) => c.depth === 0).map((c) => c.name)))
}

/** True when `selector` can only match inside an element carrying one of `owned`. */
function isScopedTo(selector: string, owned: ReadonlySet<string>): boolean {
  const { classes, combinators } = scanSelector(selector)
  const hits = classes.filter((c) => c.depth === 0 && owned.has(c.name))
  if (hits.length === 0) return false
  const last = Math.max(...hits.map((c) => c.compound))
  return combinators.slice(last).every((kind) => kind === ' ' || kind === '>')
}

function renameClasses(selector: string, renames: ReadonlyMap<string, string>): string {
  let out = selector
  for (const span of scanSelector(selector).classes.reverse()) {
    const to = renames.get(span.name)
    if (to === undefined) continue
    out = `${out.slice(0, span.start)}.${out.slice(span.start + 1, span.end)}${to.slice(span.name.length)}${out.slice(span.end)}`
  }
  return out
}

// ---- plan: into a stylesheet ----------------------------------------------

function planIntoStylesheet(
  roots: readonly PastedNode[],
  rules: readonly ParsedRule[],
  destination: StyleDestination,
  taken: ReadonlySet<string>,
  tokens: ReadonlySet<string>,
  summary: StylePlan['summary'],
): StylePlan {
  // Provisional ownership: the classes the markup uses and some rule names.
  const named = new Set(rules.flatMap((rule) => [...topLevelClasses(rule.selectors)]))
  const provisional = new Set([...tokens].filter((token) => named.has(token)))

  const written: ParsedRule[] = []
  for (const rule of rules) {
    const label = `${rule.selectors.join(', ')}${rule.atRule ? ` (in @${rule.atRule})` : ''}`
    if (rule.declarations.length === 0) continue
    if (!rule.selectors.every((selector) => isScopedTo(selector, provisional))) {
      note(summary, label)
      continue
    }
    written.push(rule)
  }

  const owned = new Set([...tokens].filter((token) => written.some((rule) => topLevelClasses(rule.selectors).has(token))))
  const renames = new Map<string, string>()
  const reserved = new Set([...tokens, ...taken])
  for (const name of owned) {
    if (!taken.has(name)) continue
    let n = 2
    while (reserved.has(`${name}-${n}`)) n += 1
    renames.set(name, `${name}-${n}`)
    reserved.add(`${name}-${n}`)
    summary.renamed.push({ from: name, to: `${name}-${n}` })
  }

  const writes: CssRuleWrite[] = written.map((rule) => ({
    selector: rule.selectors.map((selector) => renameClasses(selector, renames)).join(', '),
    declarations: toDeclarationBag(rule.declarations),
    ...(rule.atRule ? { atRule: rule.atRule } : {}),
  }))
  summary.mode = writes.length > 0 ? destination.kind : 'none'
  summary.rules = writes.length

  const classNameFor = (value: string): InsertableJsxPropValue => {
    const parts = value
      .split(/\s+/)
      .filter(Boolean)
      .map((token): ClassNamePart => {
        const local = renames.get(token) ?? token
        return owned.has(token) && destination.kind === 'module' ? { module: { binding: destination.binding, local } } : { literal: local }
      })
    return parts.some((part) => 'module' in part) ? new ClassNameTokens(parts) : parts.map((part) => ('literal' in part ? part.literal : '')).join(' ')
  }
  const planned = roots.map((node) =>
    carry(node, (props) => (typeof props.className === 'string' ? { ...props, className: classNameFor(props.className) } : props)),
  )
  return { roots: planned, writes, summary }
}

// ---- plan: inline ----------------------------------------------------------

function planInline(roots: readonly PastedNode[], rules: readonly ParsedRule[], summary: StylePlan['summary']): StylePlan {
  const inlinable: { className: string; rule: ParsedRule }[] = []
  for (const rule of rules) {
    const classes = rule.selectors.map((selector) => SINGLE_CLASS.exec(selector)?.[1])
    if (rule.atRule || classes.some((name) => name === undefined)) {
      note(summary, `${rule.selectors.join(', ')}${rule.atRule ? ` (in @${rule.atRule})` : ''}`)
      continue
    }
    for (const className of new Set(classes as string[])) inlinable.push({ className, rule })
  }
  if (inlinable.length === 0) return { roots: roots.map((node) => carry(node, (props) => props)), writes: [], summary }

  const usedRules = new Set<ParsedRule>()
  const apply = (props: Record<string, InsertableJsxPropValue | undefined>): Record<string, InsertableJsxPropValue | undefined> => {
    if (typeof props.className !== 'string') return props
    const tokens = props.className.split(/\s+/).filter(Boolean)
    const matching = inlinable.filter((rule) => tokens.includes(rule.className))
    if (matching.length === 0) return props
    const normal: Record<string, string> = {}
    const important: Record<string, string> = {}
    for (const { rule } of matching) {
      usedRules.add(rule)
      for (const { prop, value, important: isImportant } of rule.declarations) {
        const bag = isImportant ? important : normal
        bag[cssPropertyToStyleKey(prop.startsWith('--') ? prop : prop.toLowerCase())] = value
      }
    }
    const own = typeof props.style === 'object' && props.style !== null && !Array.isArray(props.style) ? (props.style as Record<string, string>) : {}
    const rest = tokens.filter((token) => !matching.some((rule) => rule.className === token))
    const next: Record<string, InsertableJsxPropValue | undefined> = { ...props, style: { ...normal, ...own, ...important } }
    if (rest.length > 0) next.className = rest.join(' ')
    else delete next.className
    return next
  }
  const planned = roots.map((node) => carry(node, apply))
  summary.mode = usedRules.size > 0 ? 'inline' : 'none'
  summary.inlined = usedRules.size
  return { roots: planned, writes: [], summary }
}

// ---- shared ----------------------------------------------------------------

function toDeclarationBag(declarations: ParsedRule['declarations']): Record<string, string> {
  const bag: Record<string, string> = {}
  for (const { prop, value, important } of declarations) bag[prop.startsWith('--') ? prop : prop.toLowerCase()] = important ? `${value} !important` : value
  return bag
}

function collectTokens(nodes: readonly PastedNode[], into: Set<string>): void {
  for (const node of nodes) {
    const className = node.props?.className
    if (typeof className === 'string') for (const token of className.split(/\s+/)) if (token) into.add(token)
    if (Array.isArray(node.children)) collectTokens(node.children as readonly PastedNode[], into)
  }
}

/** A deep copy of `node` with `props` rewritten on every element of the subtree. */
function carry(
  node: PastedNode,
  rewrite: (props: Record<string, InsertableJsxPropValue | undefined>) => Record<string, InsertableJsxPropValue | undefined>,
): PlannedNode {
  const planned: PlannedNode = { name: node.name }
  if (node.props) planned.props = rewrite({ ...(node.props as Record<string, InsertableJsxPropValue | undefined>) })
  if (typeof node.children === 'string') planned.children = node.children
  else if (Array.isArray(node.children)) planned.children = (node.children as readonly PastedNode[]).map((child) => carry(child, rewrite))
  return planned
}
