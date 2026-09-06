/**
 * setStyledDeclaration — W4-4 Phase B: rewrites ONE declaration's value inside
 * a `styled-components`/emotion tagged template, in place, in the user's own
 * `.tsx`.
 *
 * Phase A (`@core/page-parser`'s `cssInJsExtract`/`cssInJsTemplate`) made
 * `const Card = styled.div\`…\`` render: the template's CSS is flattened under
 * a synthetic class and registered read-only. This is the write half of the
 * same pair — the inspector's ordinary "type a value into a class declaration"
 * gesture, landing on the template line the value was actually written on.
 *
 * ## Why the target is a SPAN and not a codemod on a CSS file
 *
 * A styled template is a JavaScript expression that happens to contain CSS.
 * postcss cannot parse it — `${p => p.theme.color}` is not a CSS token — and
 * ts-morph has no idea a template's text is CSS at all. So neither engine can
 * do this alone, and the split here is exact:
 *
 *   - **ts-morph owns the file.** It finds the tagged template at the recorded
 *     `(line, col)`, hands over each quasi's RAW text with its absolute source
 *     offset, and performs the final `replaceText`.
 *   - **postcss owns the CSS**, through the SAME `flattenTemplateDeclarations`
 *     walk Phase A's rendering used, so the selector this write matches is the
 *     selector the canvas showed. Re-deriving the `&`/pseudo/`@media` nesting
 *     rules here would be a second implementation of "which element does this
 *     declaration style", and the day the two disagreed the editor would write
 *     a value into a rule the user was never looking at.
 *
 * The mapping between the two is one array of quasi segments. A value span
 * that lies entirely inside ONE quasi is writable; anything else touches an
 * interpolation and is refused.
 *
 * ## Every interpolation is a hole here, even the ones Phase A resolved
 *
 * Phase A RESOLVES what it can through the static evaluator: `${SPACING.md}`
 * becomes `8px` in the registry, so the canvas shows the real value. This
 * module deliberately does NOT resolve anything — every `${…}` is substituted
 * with the same sentinel Phase A uses for an unreadable one.
 *
 * That is not a shortcut, it is the honest-target rule. `padding: ${SPACING.md}`
 * has no value written in this template: the bytes live in `SPACING`'s own
 * file, and rewriting them there would change every other template that reads
 * the token. `setStringLiteral`'s discipline, one layer up — the write goes
 * where the value IS, or it refuses and says so.
 *
 * ## FAILS CLOSED, and says why
 *
 * Every decline is a NAMED refusal with a sentence for the user, never a
 * silent no-op and never an exception the caller has to classify. The
 * duplicate/shorthand/`!important` hazards are not re-invented either — the
 * flattened CSS is handed to `@core/css-codemods`' `analyzeDeclarationTarget`,
 * the same gate `server/handlers/studioCssWriteback.ts` runs before touching a
 * real stylesheet, so a styled rule and a `.css` rule refuse for the same
 * reasons in the same words.
 *
 * Out of scope by design, refused by name: adding a NEW declaration, removing
 * one, renaming a property, and anything inside emotion's OBJECT styles
 * (W4-4 Phase C).
 */
import { Node, Project, type SourceFile } from 'ts-morph'
import {
  containsUnresolvedSentinel,
  flattenTemplateDeclarations,
  isStatementPosition,
  sentinelDeclaration,
  unresolvedSentinel,
  type TemplateDeclarationSpan,
  type TemplateSentinel,
} from '@core/page-parser'
import { analyzeDeclarationTarget } from '@core/css-codemods'
import { createProject, loadSourceFile } from './locateJsxElement'

export interface SetStyledDeclarationParams {
  /** Absolute path of the `.tsx`/`.ts` file holding the template. */
  file: string
  /** 1-based line of the `styled.…` / `css` TAG — `CssInJsTemplate.loc`. */
  line: number
  /** 1-based column of that tag. */
  col: number
  /** The synthetic class Phase A registered this template under, so the flattened selectors match the registry's. */
  className: string
  /** The flattened selector the declaration lives under, e.g. `.Card_sc__a1b2c3` or `.Card_sc__a1b2c3:hover`. */
  selector: string
  /** The media QUERY (without the `@media` keyword) when the declaration sits inside a nested `@media` block. */
  atMedia?: string
  property: string
  value: string
  /** Optional pre-existing project to reuse across several edits in one batch. */
  project?: Project
}

/** Why a styled-template write declined. Each one is a complete thought the caller can show verbatim. */
export type StyledDeclarationRefusalReason =
  /** No `styled`/`css` tagged template starts at the recorded location any more. */
  | 'template-not-found'
  /** The template's CSS did not parse, or the declaration is not written in it (it arrives via an interpolated mixin, or under an interpolated selector). */
  | 'declaration-not-in-template'
  /** The value is (or touches) a `${…}` — the bytes live somewhere else. */
  | 'interpolated-value'
  /** The new value cannot be written into a template literal without changing what the template means. */
  | 'unwritable-value'
  /** `analyzeDeclarationTarget`'s verdicts, forwarded verbatim. */
  | 'duplicate-selector'
  | 'duplicate-declaration'
  | 'shorthand-override'
  | 'important-override'

export type SetStyledDeclarationResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: StyledDeclarationRefusalReason; message: string }

/**
 * A character that would end the declaration, end the template, or start an
 * interpolation. Any of them turns "set this value" into "restructure this
 * template", which is a different edit than the one the user made.
 */
const UNWRITABLE_VALUE_RE = /[`;{}\\\n\r]|\$\{/

export function setStyledDeclaration(params: SetStyledDeclarationParams): SetStyledDeclarationResult {
  const { file, line, col, className, selector, property, value, atMedia } = params

  if (UNWRITABLE_VALUE_RE.test(value)) {
    return {
      ok: false,
      reason: 'unwritable-value',
      message:
        `“${value}” cannot be written into a styled-component template — it contains a character that would end the ` +
        'declaration or the template itself (a backtick, a semicolon, a brace, a backslash, a newline, or `${`).',
    }
  }

  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const template = findTaggedTemplateAt(sourceFile, line, col)
  if (!template) {
    return {
      ok: false,
      reason: 'template-not-found',
      message:
        `Studio expected a styled-component template at ${file}:${line}:${col} and no longer finds one. Reload the ` +
        'project so it can re-read the file, then try again.',
    }
  }

  const assembled = assembleRawBody(template)
  if (!assembled) {
    return { ok: false, reason: 'template-not-found', message: 'This styled template has a shape Studio cannot read back.' }
  }

  const spans = flattenTemplateDeclarations(className, assembled.body, assembled.sentinels)
  const matches = spans.filter(
    (span) =>
      normalizeSelector(span.selector) === normalizeSelector(selector) &&
      span.property.toLowerCase() === property.toLowerCase() &&
      matchesMedia(span, atMedia),
  )

  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'declaration-not-in-template',
      message:
        `“${property}” is not written in ${templateLabel(template)}'s own template. It comes from an interpolated ` +
        'block (a shared mixin, a theme helper) or from a rule whose selector is interpolated, so there is no single ' +
        'line here to change — edit it where it is written.',
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'duplicate-declaration',
      message:
        `“${property}” is declared more than once under “${selector}” in this template. The later one is the one ` +
        'taking effect, so Studio will not guess which line you meant — remove the duplicate and try again.',
    }
  }

  const match = matches[0]!

  // The walk reports an interpolated declaration rather than hiding it, so
  // "set from a `${…}`" gets its own sentence instead of the much less useful
  // "not written here". `containsUnresolvedSentinel` is the second half of the
  // same question for a value that is only PARTLY a hole.
  if (match.interpolated || containsUnresolvedSentinel(match.value)) {
    return {
      ok: false,
      reason: 'interpolated-value',
      message:
        `“${property}” is set from an interpolation in ${templateLabel(template)}'s template, so its value is not ` +
        'written there — it is computed from a prop, a theme value, or a constant in another file. Change it at ' +
        'its source.',
    }
  }

  // The same honest-target gate a real stylesheet gets, run on this template's
  // own flattened CSS: a covering shorthand or an `!important` sibling makes
  // the write invisible whether the bytes live in a `.css` file or a quasi.
  const analysis = analyzeDeclarationTarget(
    serializeSpans(spans),
    match.selector,
    property,
    match.conditions.length === 1 ? { atMedia: mediaParams(match.conditions[0]!) } : {},
  )
  if (!analysis.ok) return { ok: false, reason: analysis.refusal.reason, message: analysis.refusal.message }

  const source = toSourceRange(assembled.segments, match)
  if (!source) {
    return {
      ok: false,
      reason: 'interpolated-value',
      message:
        `“${property}”'s value spans an interpolation in this template, so only part of it is written here. ` +
        'Studio will not rewrite half a value.',
    }
  }

  if (match.value.trim() === value.trim()) return { ok: true, changed: false }

  // Preserve the author's own leading whitespace between the colon and the
  // value: postcss counts it as part of `raws.between`, not the value, so a
  // span never includes it — but a trailing run can, and replacing it would
  // reflow the line for no reason.
  const trailing = match.value.length - match.value.trimEnd().length
  sourceFile.replaceText([source.start, source.end - trailing], value)
  sourceFile.saveSync()
  return { ok: true, changed: true }
}

/**
 * The `TaggedTemplateExpression` whose TAG starts at (line, col) — the same
 * anchor `CssInJsTemplate.loc` records.
 *
 * The search is deliberately narrow: the node at that exact position plus at
 * most four ancestors, each of which must still start there. `styled.div`
 * lands on the `styled` identifier, whose parent is the property access,
 * whose parent is the tagged template — three hops at most for every shape
 * Phase A recognises (`styled.div`, `styled(X)`, `styled.div.attrs({…})`,
 * a bare `css`). A wider walk is how a write lands on the wrong template.
 */
function findTaggedTemplateAt(sourceFile: SourceFile, line: number, col: number): Node | undefined {
  let pos: number
  try {
    pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, col - 1)
  } catch {
    return undefined
  }
  let current = sourceFile.getDescendantAtPos(pos)
  for (let hops = 0; current && hops < 5; hops++) {
    if (current.getStart() !== pos) return undefined
    if (Node.isTaggedTemplateExpression(current) && current.getTag().getStart() === pos) return current
    current = current.getParent()
  }
  return undefined
}

/** A run of RAW quasi text: where it sits in the assembled body, and where the same bytes sit in the file. */
interface QuasiSegment {
  bodyStart: number
  bodyEnd: number
  sourceStart: number
}

/**
 * The template's body as ONE string, built from each quasi's RAW text with
 * every `${…}` replaced by the sentinel Phase A would use for an unreadable
 * one — plus the segment map that takes an offset in that string back to an
 * offset in the file.
 *
 * RAW, not cooked, on purpose. `getLiteralText()` resolves escapes
 * (`content: '\\201C'` cooks to a single backslash), which makes body offsets
 * and file offsets drift apart by one character per escape — and this
 * function exists to keep them in lockstep. Reading raw keeps the mapping
 * linear inside every segment; the CSS a declaration's value is matched and
 * rewritten with is then the same text the file literally contains, which is
 * exactly what a write wants.
 */
function assembleRawBody(
  tagged: Node,
): { body: string; sentinels: TemplateSentinel[]; segments: QuasiSegment[] } | undefined {
  if (!Node.isTaggedTemplateExpression(tagged)) return undefined
  const template = tagged.getTemplate()
  const segments: QuasiSegment[] = []
  const sentinels: TemplateSentinel[] = []

  if (Node.isNoSubstitutionTemplateLiteral(template)) {
    const raw = rawQuasiText(template.getText())
    segments.push({ bodyStart: 0, bodyEnd: raw.length, sourceStart: template.getStart() + 1 })
    return { body: raw, sentinels, segments }
  }
  if (!Node.isTemplateExpression(template)) return undefined

  const head = template.getHead()
  let body = rawQuasiText(head.getText())
  segments.push({ bodyStart: 0, bodyEnd: body.length, sourceStart: head.getStart() + 1 })

  for (const span of template.getTemplateSpans()) {
    const block = isStatementPosition(body)
    sentinels.push({ expression: shortenExpression(span.getExpression().getText()), block })
    body += block ? sentinelDeclaration(sentinels.length - 1) : unresolvedSentinel(sentinels.length - 1)

    const literal = span.getLiteral()
    const raw = rawQuasiText(literal.getText())
    segments.push({ bodyStart: body.length, bodyEnd: body.length + raw.length, sourceStart: literal.getStart() + 1 })
    body += raw
  }

  return { body, sentinels, segments }
}

/**
 * A quasi node's text minus its delimiters. Every quasi opens with exactly one
 * character (a backtick for the head / no-substitution form, `}` for a middle
 * or tail) and closes with either `${` (head, middle) or a backtick (tail,
 * no-substitution) — so the content always starts at index 1, and the tail
 * length is the only thing that varies.
 */
function rawQuasiText(text: string): string {
  return text.endsWith('${') ? text.slice(1, -2) : text.slice(1, -1)
}

/** Matches `cssInJsExtract`'s own truncation, so a sentinel's recorded expression reads the same on both sides. */
function shortenExpression(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat
}

/**
 * The declaration value's absolute range in the file, or `undefined` when the
 * span is not wholly inside a single quasi — i.e. when the value is partly
 * written here and partly interpolated (`margin: ${gap} auto`), which has no
 * single honest target.
 */
function toSourceRange(
  segments: readonly QuasiSegment[],
  span: TemplateDeclarationSpan,
): { start: number; end: number } | undefined {
  const segment = segments.find((s) => span.valueStart >= s.bodyStart && span.valueEnd <= s.bodyEnd)
  if (!segment) return undefined
  const offset = segment.sourceStart - segment.bodyStart
  return { start: span.valueStart + offset, end: span.valueEnd + offset }
}

/** The flattened CSS `analyzeDeclarationTarget` reads — rebuilt from the spans so both halves see exactly one text. */
function serializeSpans(spans: readonly TemplateDeclarationSpan[]): string {
  const blocks: string[] = []
  let current: { selector: string; conditions: string[]; declarations: string[] } | undefined
  for (const span of spans) {
    const declaration = `${span.property}: ${span.value.trim()}${span.important ? ' !important' : ''}`
    if (current && current.selector === span.selector && sameConditions(current.conditions, span.conditions)) {
      current.declarations.push(declaration)
      continue
    }
    if (current) blocks.push(wrapConditions(current.conditions, `${current.selector} { ${current.declarations.join('; ')}; }`))
    current = { selector: span.selector, conditions: [...span.conditions], declarations: [declaration] }
  }
  if (current) blocks.push(wrapConditions(current.conditions, `${current.selector} { ${current.declarations.join('; ')}; }`))
  return blocks.join('\n')
}

function wrapConditions(conditions: readonly string[], block: string): string {
  return conditions.reduceRight((inner, condition) => `${condition} { ${inner} }`, block)
}

function sameConditions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/**
 * Whether a span sits under the media query the caller named. A caller with no
 * `atMedia` means the template's UNCONDITIONAL declarations, so a span inside
 * any `@media` is a different target; a caller with one matches a span nested
 * exactly one level deep, because a doubly-nested query is a condition pair
 * this edit shape cannot name.
 */
function matchesMedia(span: TemplateDeclarationSpan, atMedia: string | undefined): boolean {
  if (!atMedia) return span.conditions.length === 0
  if (span.conditions.length !== 1) return false
  return normalizeQuery(mediaParams(span.conditions[0]!)) === normalizeQuery(atMedia)
}

/** `@media (min-width: 700px)` -> `(min-width: 700px)`. Anything that is not an `@media` keeps its whole text, so it can never match a media query. */
function mediaParams(condition: string): string {
  const match = /^@media\s+(.*)$/i.exec(condition.trim())
  return match ? match[1]!.trim() : condition.trim()
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').replace(/\s*([:,])\s*/g, '$1').trim().toLowerCase()
}

/**
 * Selector spelling differs harmlessly between the two sides: the caller's
 * comes back through happy-dom's CSSOM (`cssToStyleRules`), which respaces
 * combinators, while this module's is the flattener's own string. Compared on
 * a normalised form so `.a>.b` and `.a > .b` are one selector, and never on
 * anything looser — a selector is what decides which element a write lands on.
 */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s*([>+~,])\s*/g, '$1').replace(/\s+/g, ' ').trim()
}

/** The binding name for a message, recovered from the declaration the template initialises. */
function templateLabel(tagged: Node): string {
  const parent = tagged.getParent()
  return parent && Node.isVariableDeclaration(parent) ? parent.getName() : 'this component'
}
