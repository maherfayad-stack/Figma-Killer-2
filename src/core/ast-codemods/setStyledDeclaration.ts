/**
 * setStyledDeclaration — W4-4 Phase B (rewritten for G-5): writes ONE
 * declaration into a `styled-components`/emotion tagged template, in place, in
 * the user's own `.tsx`, and always lands it.
 *
 * Phase A (`@core/page-parser`'s `cssInJsExtract`/`cssInJsTemplate`) made
 * `const Card = styled.div\`…\`` render: the template's CSS is flattened under
 * a synthetic class and registered. This is the write half of the same pair —
 * the inspector's ordinary "type a value into a class declaration" gesture,
 * landing on the template line the value was actually written on, or after it.
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
 * The mapping between the two is one array of quasi segments. A position that
 * lies inside ONE quasi (or on the edge of one) is writable; the bytes of an
 * interpolation never are.
 *
 * ## The ladder: the first honest rung wins (G-5)
 *
 * This module used to refuse an interpolated value, a declaration the template
 * does not write, a covering shorthand, `!important`, a doubled declaration.
 * Each of those is a rung now, in this order:
 *
 *   1. **The winning declaration.** The one the cascade reads (the last
 *      `!important`, else the last, a covering shorthand counting as declaring
 *      each of its longhands) is rewritten in place when it is a literal wholly
 *      inside one quasi. A covering `!important` shorthand is rewritten with
 *      that one side changed (`expandShorthandSide`).
 *   2. **An override.** Anything else — the winner is a `${…}`, or half of one,
 *      or a covering shorthand, or the template never writes the property — gets
 *      a NEW declaration appended at the end of the same block, where it comes
 *      last and wins (carrying its own `!important` when it must beat one). The
 *      interpolation is untouched: the bytes behind it live in another file and
 *      rewriting them would change every other template that reads them
 *      (`setStringLiteral`'s discipline, one layer up) — the override is the one
 *      honest target inside THIS template.
 *   3. **Inline** is the CALLER's rung: a value that cannot be spelled in a
 *      template literal at all (`isStyledWritableValue`) is refused
 *      `unwritable-value`, and the client, which asks `isStyledWritableValue`
 *      first, never sends it here — it styles the element instead.
 *
 * `landing` reports the rung for the inspector's chip: `'rule'` is rung 1 (or a
 * declaration added to a block that did not write the property), `'expanded'`
 * a covering shorthand rewritten with one side changed, `'override'` an
 * appended line that shadows another.
 *
 * Still refused by name, because they are the file being unreadable and not a
 * style edit that cannot land: `template-not-found` (nothing starts there any
 * more) and `declaration-not-in-template` (the selector or condition is not
 * written in this template — an interpolated selector, a stale target).
 * Removing a declaration, renaming one, and emotion's OBJECT styles are other
 * edits (W4-4 Phase C).
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
import { expandShorthandSide, isStyledWritableValue, shorthandCovers } from '@core/css-codemods'
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
  /**
   * The conditional block the declaration sits inside, as `name params`
   * (`media (min-width: 700px)`, `container (min-width: 400px)`,
   * `supports (display: grid)` — `@core/css-codemods`' `cssAtRuleScope.ts`),
   * when it is nested one level in a template's `@media`/`@container`/
   * `@supports` block (P3-C, WB-31: `@media` used to be the only one).
   */
  atRule?: string
  property: string
  value: string
  /** Optional pre-existing project to reuse across several edits in one batch. */
  project?: Project
}

/** Why a styled-template write declined. Each one is a complete thought the caller can show verbatim. */
export type StyledDeclarationRefusalReason =
  /** No `styled`/`css` tagged template starts at the recorded location any more. */
  | 'template-not-found'
  /** The template's CSS did not parse, or the selector/condition is not written in it (an interpolated selector, a stale target). */
  | 'declaration-not-in-template'
  /** The new value cannot be written into a template literal without changing what the template means. */
  | 'unwritable-value'

/** Which rung took the value — see this module's doc, "The ladder". */
export type StyledDeclarationLanding = 'rule' | 'expanded' | 'override'

export type SetStyledDeclarationResult =
  | { ok: true; changed: boolean; landing: StyledDeclarationLanding }
  | { ok: false; reason: StyledDeclarationRefusalReason; message: string }

export function setStyledDeclaration(params: SetStyledDeclarationParams): SetStyledDeclarationResult {
  const { file, line, col, className, selector, property, value, atRule } = params

  if (!isStyledWritableValue(value)) {
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
  // Every declaration of the block the caller named, in source order. The LAST
  // one's append point is the end of the block (every span of a rule shares it).
  const block = spans.filter(
    (span) => normalizeSelector(span.selector) === normalizeSelector(selector) && matchesScope(span, atRule),
  )
  const anchor = block[block.length - 1]
  if (!anchor) {
    return {
      ok: false,
      reason: 'declaration-not-in-template',
      message:
        `“${selector}” is not written in ${templateLabel(template)}'s own template. It comes from an interpolated ` +
        'selector or block, so there is no place in this template to put the declaration — edit it where it is written.',
    }
  }

  // The declaration the cascade reads: the last `!important`, else the last,
  // where a covering shorthand counts as declaring each of its longhands.
  const prop = property.toLowerCase()
  const relevant = block.filter((span) => {
    const spanProp = span.property.toLowerCase()
    return spanProp === prop || shorthandCovers(spanProp, prop)
  })
  const winner = [...relevant].reverse().find((span) => span.important) ?? relevant[relevant.length - 1]

  const write = createWriter(sourceFile, assembled.segments)

  if (!winner) return append(write, anchor, property, value, false, 'rule')

  const writtenHere = !winner.interpolated && !containsUnresolvedSentinel(winner.value)
  if (winner.property.toLowerCase() === prop) {
    if (!writtenHere) return append(write, anchor, property, value, winner.important, 'override')
    if (winner.value.trim() === value.trim()) return { ok: true, changed: false, landing: 'rule' }
    return write.replaceValue(winner, value) ? { ok: true, changed: true, landing: 'rule' } : append(write, anchor, property, value, winner.important, 'override')
  }

  // A covering shorthand has the last word. `!important` can only be beaten by
  // the same shorthand with this side changed, or by an `!important` longhand.
  if (winner.important && writtenHere) {
    const expanded = expandShorthandSide(winner.property, winner.value, prop, value)
    if (expanded !== null && write.replaceValue(winner, expanded)) return { ok: true, changed: true, landing: 'expanded' }
  }
  return append(write, anchor, property, value, winner.important, 'override')
}

/** Appends `property: value;` at the end of `anchor`'s block, which comes last there and so wins among equals. */
function append(
  write: TemplateWriter,
  anchor: TemplateDeclarationSpan,
  property: string,
  value: string,
  important: boolean,
  landing: StyledDeclarationLanding,
): SetStyledDeclarationResult {
  const text = `${anchor.appendNeedsSemicolon ? ';' : ''}${anchor.appendLead}${property}: ${value}${important ? ' !important' : ''};`
  if (!write.insertAt(anchor.appendAt, text)) {
    return {
      ok: false,
      reason: 'declaration-not-in-template',
      message:
        `The end of ${anchor.selector}'s block sits inside an interpolation, so there is no place in this template to ` +
        'put the declaration — edit it where it is written.',
    }
  }
  return { ok: true, changed: true, landing }
}

/** The two byte-level moves a rung makes, both through the quasi segment map and both saving the file. */
interface TemplateWriter {
  /** Replaces a declaration's VALUE when it lies wholly inside one quasi (an interpolation never does). */
  replaceValue(span: TemplateDeclarationSpan, value: string): boolean
  /** Inserts `text` at a body offset that sits inside, or on the edge of, one quasi. */
  insertAt(bodyOffset: number, text: string): boolean
}

function createWriter(sourceFile: SourceFile, segments: readonly QuasiSegment[]): TemplateWriter {
  const eol = sourceFile.getFullText().includes('\r\n') ? '\r\n' : '\n'
  return {
    replaceValue(span, value) {
      const range = toSourceRange(segments, span)
      if (!range) return false
      // Preserve the author's own leading whitespace between the colon and the
      // value: postcss counts it as part of `raws.between`, not the value, so a
      // span never includes it — but a trailing run can, and replacing it would
      // reflow the line for no reason.
      const trailing = span.value.length - span.value.trimEnd().length
      sourceFile.replaceText([range.start, range.end - trailing], value)
      sourceFile.saveSync()
      return true
    },
    insertAt(bodyOffset, text) {
      const segment = segments.find((s) => bodyOffset >= s.bodyStart && bodyOffset <= s.bodyEnd)
      if (!segment) return false
      const at = segment.sourceStart + (bodyOffset - segment.bodyStart)
      sourceFile.replaceText([at, at], eol === '\n' ? text : text.replace(/\n/g, eol))
      sourceFile.saveSync()
      return true
    },
  }
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
 * single honest target for a rewrite (the override rung takes it instead).
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

/**
 * Whether a span sits under the conditional block the caller named. A caller
 * with no `atRule` means the template's UNCONDITIONAL declarations, so a span
 * inside any block is a different target; a caller with one matches a span
 * nested exactly one level deep, because a doubly-nested condition is a pair
 * this edit shape cannot name. The at-rule NAME is compared too: a
 * `@container (min-width: 400px)` is not a `@media (min-width: 400px)`.
 */
function matchesScope(span: TemplateDeclarationSpan, atRule: string | undefined): boolean {
  if (!atRule) return span.conditions.length === 0
  if (span.conditions.length !== 1) return false
  return normalizeQuery(conditionScope(span.conditions[0]!)) === normalizeQuery(atRule)
}

/** `@media (min-width: 700px)` -> `media (min-width: 700px)` — a flattened condition as the `name params` scope `atRule` spells. */
function conditionScope(condition: string): string {
  return condition.trim().replace(/^@/, '')
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
