/**
 * cssInJsTemplate — the CSS half of W4-4 Phase A: one styled template's BODY
 * text (interpolations already substituted) plus the synthetic class name it
 * belongs to, flattened into ordinary, top-level CSS rules the existing
 * `cssToStyleRules` registry can parse.
 *
 * ## Why postcss and not string splitting
 *
 * A styled template is nested CSS. `&:hover`, `& > *`, `&&`, a nested
 * `@media`, and a nested rule inside that `@media` are all ordinary,
 * everyday shapes in a real styled-components file, and every one of them
 * changes which element a declaration applies to. Splitting the body on `;`
 * and `}` gets the flat declarations right and silently mangles all of the
 * above — which is worse than not extracting at all, because the canvas then
 * shows CSS the app never applied. postcss is already a dependency
 * (`@core/css-codemods` round-trips real `.css` files through it), it parses
 * nested rules structurally out of the box, and its own parse failure is a
 * clean, catchable signal rather than a wrong answer.
 *
 * ## The sentinel
 *
 * An interpolation the evaluator could not resolve is substituted with an
 * identifier-safe sentinel token BEFORE the text reaches postcss, so the body
 * still parses. This module then deletes exactly the node that carries one —
 * the declaration, the nested rule, or the at-rule — and reports it. That is
 * the "drops ONLY that declaration" rule: an unreadable `${(p) => p.color}`
 * costs one `color:` line, never the other twenty declarations around it.
 *
 * A STATEMENT-position interpolation (`${someMixin}` on a line of its own,
 * which is how a shared mixin is spliced in) cannot be a bare sentinel word —
 * postcss rejects that outright, which would cost the whole template. The
 * extractor emits `sentinelDeclaration(i)` there instead: a syntactically
 * valid custom-property declaration that postcss parses happily and this
 * module then drops, reporting it as `block-dropped` rather than
 * `declaration-dropped` because `sentinels[i].block` says which it was.
 *
 * ## Nesting rules, stated
 *
 * A nested selector containing `&` substitutes the parent for every `&`
 * (`&&` -> `.x.x`, `& > *` -> `.x > *`). A nested selector STARTING with a
 * pseudo (`:hover { … }`, written without the ampersand) attaches to the
 * parent with no space — that is what styled-components' own compiler does
 * with it, and reading it as a descendant would move the rule onto a child
 * element. Anything else is an ordinary descendant. Comma lists on either
 * side cross-produce, as CSS nesting itself specifies.
 *
 * ## Two readers of one walk (W4-4 Phase B)
 *
 * Phase A needed only the flattened CSS TEXT. The write-back
 * (`@core/ast-codemods`'s `setStyledDeclaration`) needs the same flattening —
 * the same `&` substitution, the same pseudo rule, the same `@media`
 * descent — but paired with WHERE in the template body each surviving
 * declaration's value was written, so a value edit can be spliced back into
 * the quasi it came from.
 *
 * Both come off ONE walk (`flattenToRules`). Re-deriving the nesting rules in
 * the codemod would mean two implementations of "which element does this
 * declaration style", and the day they disagreed the editor would write a
 * value into a rule the canvas never showed.
 *
 * Pure: no ts-morph, no filesystem, no evaluator. Never throws — a parse
 * failure comes back as a `template-unreadable` finding with no CSS.
 */
import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Rule } from 'postcss'
import type { CssInJsFinding } from './types'

/** Interpolation the evaluator declined, in a position postcss can still parse. See this module's "The sentinel". */
const SENTINEL_PREFIX = '__STUDIO_CSSINJS_UNRESOLVED_'

/** The token substituted for an unresolved interpolation in VALUE or SELECTOR position. */
export function unresolvedSentinel(index: number): string {
  return `${SENTINEL_PREFIX}${index}__`
}

/** The whole statement substituted for an unresolved interpolation in STATEMENT position — valid CSS, so the rest of the template still parses. */
export function sentinelDeclaration(index: number): string {
  return `--studio-cssinjs-unresolved-${index}: ${unresolvedSentinel(index)};`
}

const SENTINEL_RE = new RegExp(`${SENTINEL_PREFIX}(\\d+)__`)

/** True when `text` carries a substituted interpolation — the write-back's "this value is not written in this template" test. */
export function containsUnresolvedSentinel(text: string): boolean {
  return text.includes(SENTINEL_PREFIX)
}

/**
 * True when the next thing written into a template body would start a
 * STATEMENT rather than continue a declaration's value — i.e. nothing since
 * the last `;`/`{`/`}` has opened a property with a `:`. That is the
 * `${sharedMixin}` shape, and it needs a whole valid declaration substituted
 * rather than a bare word, or postcss rejects the entire template.
 *
 * Lives here rather than in `cssInJsExtract.ts` (its first caller) because it
 * is a question about CSS TEXT, and both the read side and the write side
 * (`setStyledDeclaration`) have to answer it identically — the sentinel each
 * one substitutes has to occupy the same position, or the two disagree about
 * which declaration is which.
 */
export function isStatementPosition(textSoFar: string): boolean {
  let segment = textSoFar
  for (const delimiter of [';', '{', '}']) {
    const index = segment.lastIndexOf(delimiter)
    if (index >= 0) segment = segment.slice(index + 1)
  }
  return !segment.includes(':')
}

/** One unresolved interpolation, as the extractor recorded it. */
export interface TemplateSentinel {
  /** The interpolation's own source text, for the finding message. */
  expression: string
  /** True when it stood alone as a statement (a spliced mixin) rather than inside a declaration's value. */
  block: boolean
}

/**
 * A body bigger than this is not a hand-written component's styles — it is a
 * vendored blob or a pathological generated string, and parsing it buys
 * nothing. Same posture as `inlineSvg.ts`'s `MAX_MARKUP_LENGTH`.
 */
const MAX_TEMPLATE_BODY_BYTES = 64 * 1024

/** Nesting deeper than this in a single template is not a shape worth chasing; the whole template reports unreadable rather than half-flattening. */
const MAX_NEST_DEPTH = 8

/** At-rules whose body is more rules (so flattening descends through them, carrying the condition down). Anything else inside a template is reported, not guessed at. */
const CONDITIONAL_AT_RULES: ReadonlySet<string> = new Set(['media', 'supports', 'container', 'layer'])

export interface FlattenedTemplateCss {
  /** Flattened, top-level CSS. Empty when nothing survived. */
  css: string
  /** How many declarations reached `css`. */
  declarationCount: number
  findings: CssInJsFinding[]
}

/** `sentinels[i]` describes the interpolation `unresolvedSentinel(i)`/`sentinelDeclaration(i)` stands in for — its source text (for the message) and whether it stood alone as a statement. */
export function flattenTemplateCss(
  className: string,
  body: string,
  sentinels: readonly TemplateSentinel[],
): FlattenedTemplateCss {
  const walked = flattenToRules(className, body, sentinels)
  if (!('rules' in walked)) return { css: '', declarationCount: 0, findings: walked.findings }
  const declarationCount = walked.rules.reduce((n, r) => n + r.declarations.filter((d) => !d.dropped).length, 0)
  return { css: serializeFlatRules(walked.rules), declarationCount, findings: walked.findings }
}

/**
 * One surviving declaration, paired with WHERE its value is written in `body`
 * — the write-back's whole reason for existing. `valueStart`/`valueEnd` are
 * offsets into `body` itself (the `.<className>{…}` wrapper this module parses
 * through is already subtracted), so a caller that built `body` out of a
 * template literal's quasis can map them straight back into the source file.
 *
 * `selector` and `conditions` are the FLATTENED ones — the same strings
 * `flattenTemplateCss` serialises and therefore the same ones the style
 * registry ends up keyed by.
 */
export interface TemplateDeclarationSpan {
  selector: string
  /** `@media (…)`, outermost first — the same list `flattenTemplateCss` wraps this rule in. */
  conditions: string[]
  property: string
  /** The declaration's value exactly as written in `body`, unparsed. */
  value: string
  valueStart: number
  valueEnd: number
  important: boolean
  /**
   * True when this declaration carries an unresolved interpolation and was
   * therefore DROPPED from the rendered CSS. Reported rather than omitted
   * because "this property is set from a `${…}`" and "this property is not in
   * this template at all" are two different sentences to show a user, and only
   * the walk can tell them apart.
   */
  interpolated: boolean
}

/**
 * Every declaration this template contributes, with its value's span in
 * `body` — INCLUDING the interpolated ones `flattenTemplateCss` drops, flagged
 * as such. Same walk, same nesting rules — see this module's "Two readers of
 * one walk". Empty when the body does not parse at all.
 */
export function flattenTemplateDeclarations(
  className: string,
  body: string,
  sentinels: readonly TemplateSentinel[],
): TemplateDeclarationSpan[] {
  const walked = flattenToRules(className, body, sentinels)
  if (!('rules' in walked)) return []

  // Everything postcss reported is offset into the wrapper this module parses
  // (`.<className>{` + body + `\n}`), so the prefix comes back off once here.
  const prefix = className.length + 2
  const spans: TemplateDeclarationSpan[] = []
  for (const rule of walked.rules) {
    for (const declaration of rule.declarations) {
      const span = declarationValueSpan(declaration.node, body, prefix)
      if (!span) continue
      spans.push({
        selector: rule.selector,
        conditions: [...rule.conditions],
        property: declaration.node.prop,
        important: declaration.node.important === true,
        interpolated: declaration.dropped,
        ...span,
      })
    }
  }
  return spans
}

/**
 * The offsets of a declaration's VALUE inside `body`, or `undefined` when the
 * arithmetic does not check out against the text itself.
 *
 * postcss gives the declaration's own start offset plus `raws.between` — the
 * colon and whatever whitespace or comment surrounds it — so the value begins
 * exactly `prop.length + between.length` in. The final
 * `body.slice(...) === raw` assertion is not defensive noise: this arithmetic
 * is what decides which bytes of a user's file get overwritten, so a shape it
 * does not anticipate (a comment spliced INSIDE the property name, which
 * postcss records separately and this does not model) must produce NO span
 * rather than a span pointing at the wrong characters.
 */
function declarationValueSpan(
  node: Declaration,
  body: string,
  prefix: number,
): { value: string; valueStart: number; valueEnd: number } | undefined {
  const start = node.source?.start?.offset
  if (start === undefined) return undefined
  const between = node.raws.between ?? ':'
  const value = node.raws.value?.raw ?? node.value
  const valueStart = start - prefix + node.prop.length + between.length
  const valueEnd = valueStart + value.length
  if (valueStart < 0 || valueEnd > body.length) return undefined
  if (body.slice(valueStart, valueEnd) !== value) return undefined
  return { value, valueStart, valueEnd }
}

/**
 * One declaration the walk reached: the text `flattenTemplateCss` serialises,
 * the postcss node the write-back reads offsets off, and whether it was
 * DROPPED for carrying an interpolation. A dropped declaration is kept in the
 * walk (and skipped at serialisation) so the write side can tell "set from a
 * `${…}`" apart from "not written here at all".
 */
interface FlatDeclaration {
  text: string
  node: Declaration
  dropped: boolean
}

interface FlatRule {
  selector: string
  /** `@media (…)`, outermost first. */
  conditions: string[]
  declarations: FlatDeclaration[]
}

/** The one walk both public readers share — see this module's "Two readers of one walk". */
function flattenToRules(
  className: string,
  body: string,
  sentinels: readonly TemplateSentinel[],
): { rules: FlatRule[]; findings: CssInJsFinding[] } | { findings: CssInJsFinding[] } {
  if (body.length > MAX_TEMPLATE_BODY_BYTES) {
    return {
      findings: [
        {
          kind: 'template-unreadable',
          message: `This template's CSS is ${Math.round(body.length / 1024)} KB — past the ${MAX_TEMPLATE_BODY_BYTES / 1024} KB cap, so none of it was extracted.`,
        },
      ],
    }
  }

  let root
  try {
    root = postcss.parse(`.${className}{${body}\n}`)
  } catch (err) {
    return {
      findings: [
        {
          kind: 'template-unreadable',
          message: `This template's CSS could not be parsed: ${err instanceof Error ? err.message : 'unknown parse error'}.`,
        },
      ],
    }
  }

  const rule = root.first
  if (!rule || rule.type !== 'rule') {
    return { findings: [{ kind: 'template-unreadable', message: 'This template produced no CSS rule.' }] }
  }

  const findings: CssInJsFinding[] = []
  const rules: FlatRule[] = []
  flatten(rule, `.${className}`, [], rules, findings, sentinels, 0)
  return { rules, findings }
}

function serializeFlatRules(rules: readonly FlatRule[]): string {
  return rules
    .map(serializeFlatRule)
    .filter((block) => block.length > 0)
    .join('\n')
}

/** `''` for a rule whose every declaration was dropped — an empty block would be CSS the app never had. */
function serializeFlatRule(rule: FlatRule): string {
  const kept = rule.declarations.filter((d) => !d.dropped)
  if (kept.length === 0) return ''
  const block = `${rule.selector} { ${kept.map((d) => d.text).join('; ')}; }`
  return rule.conditions.reduceRight((inner, condition) => `${condition} { ${inner} }`, block)
}

/**
 * Emits the container's OWN declarations before descending, so the base rule
 * precedes the `&:hover`/`@media` rules that are meant to override it — the
 * order the author wrote, and the order the cascade needs.
 */
function flatten(
  container: Container<ChildNode>,
  selector: string,
  conditions: readonly string[],
  out: FlatRule[],
  findings: CssInJsFinding[],
  sentinels: readonly TemplateSentinel[],
  depth: number,
): void {
  if (depth > MAX_NEST_DEPTH) {
    findings.push({ kind: 'template-unreadable', message: `Nested deeper than ${MAX_NEST_DEPTH} levels; the deeper rules were not extracted.` })
    return
  }

  const declarations: FlatDeclaration[] = []
  const children: (Rule | AtRule)[] = []

  for (const node of container.nodes ?? []) {
    if (node.type === 'decl') {
      const index = firstSentinel(`${node.prop}:${node.value}`)
      if (index !== undefined) {
        const expression = expressionFor(index, sentinels)
        findings.push(
          sentinels[index]?.block
            ? {
                kind: 'block-dropped',
                expression,
                message: `A spliced block was dropped: \`${expression}\` cannot be read from source, so whatever declarations it contributes are missing.`,
              }
            : {
                kind: 'declaration-dropped',
                property: node.prop,
                expression,
                message: `\`${node.prop}\` was dropped: its value depends on \`${expression}\`, which cannot be read from source.`,
              },
        )
        // Kept in the walk, out of the CSS — see `FlatDeclaration.dropped`.
        declarations.push({ text: '', node, dropped: true })
        continue
      }
      declarations.push({ text: `${node.prop}: ${node.value}${node.important ? ' !important' : ''}`, node, dropped: false })
      continue
    }
    if (node.type === 'rule' || node.type === 'atrule') children.push(node)
  }

  if (declarations.length > 0) out.push({ selector, conditions: [...conditions], declarations })

  for (const node of children) {
    if (node.type === 'rule') {
      const index = firstSentinel(node.selector)
      if (index !== undefined) {
        const expression = expressionFor(index, sentinels)
        findings.push({
          kind: 'selector-dropped',
          expression,
          message: `A nested rule was dropped: its selector depends on \`${expression}\`, which cannot be read from source.`,
        })
        continue
      }
      const nested = resolveNestedSelector(node.selector, selector)
      if (nested.length === 0) {
        // The selector was ENTIRELY an unresolved statement-position
        // interpolation, already dropped as a declaration above — so there is
        // no selector text left to attach these declarations to. Reported
        // there, not double-reported here.
        continue
      }
      flatten(node, nested, conditions, out, findings, sentinels, depth + 1)
      continue
    }

    const name = node.name.toLowerCase()
    const index = firstSentinel(node.params)
    if (index !== undefined) {
      const expression = expressionFor(index, sentinels)
      findings.push({
        kind: 'selector-dropped',
        expression,
        message: `An \`@${name}\` block was dropped: its condition depends on \`${expression}\`, which cannot be read from source.`,
      })
      continue
    }
    if (!CONDITIONAL_AT_RULES.has(name)) {
      // `@keyframes`/`@font-face` inside a template define a GLOBAL name, not
      // a rule scoped to this class — hoisting one would leak a name the
      // registry has no honest place for. Reported, not guessed at.
      findings.push({
        kind: 'block-dropped',
        message: `\`@${name}\` inside a styled template is not extracted — it declares a global name rather than styling this element.`,
      })
      continue
    }
    flatten(node, selector, [...conditions, `@${name} ${node.params}`.trim()], out, findings, sentinels, depth + 1)
  }
}

function firstSentinel(text: string): number | undefined {
  const match = SENTINEL_RE.exec(text)
  return match ? Number(match[1]) : undefined
}

function expressionFor(index: number, sentinels: readonly TemplateSentinel[]): string {
  return sentinels[index]?.expression ?? 'an interpolation'
}

/**
 * `&`-substitution + the descendant/pseudo rules stated in this module's doc
 * comment. Both sides cross-produce over their comma lists.
 */
export function resolveNestedSelector(childSelector: string, parentSelector: string): string {
  const parents = splitSelectorList(parentSelector)
  const children = splitSelectorList(childSelector)
  const combined: string[] = []
  for (const parent of parents) {
    for (const child of children) {
      if (child.includes('&')) combined.push(child.replace(/&/g, parent))
      else if (child.startsWith(':')) combined.push(`${parent}${child}`)
      else combined.push(`${parent} ${child}`)
    }
  }
  return combined.join(', ')
}

/** Splits on TOP-LEVEL commas only — `:is(a, b)` and `[title="a,b"]` stay whole. */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let current = ''
  for (const char of selector) {
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '(' || char === '[') depth++
    if (char === ')' || char === ']') depth--
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  parts.push(current.trim())
  return parts.filter((p) => p.length > 0)
}
