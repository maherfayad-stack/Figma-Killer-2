/**
 * classNameTemplate - removing class tokens from a `` className={`a ${styles.b}`} ``.
 *
 * `setJsxClassName` only ever APPENDS to a template literal, because a token
 * might live in an interpolated part nobody can read. That is true of an
 * arbitrary `${x}`, but not of the template this codemod itself writes
 * (`` `${styles.greet} ${styles.counter}` ``): every span there is one whole
 * space-separated token. When EVERY span of a template is such a token, the
 * template is just a class list written the long way, and a remove (the swap of
 * one text style for another) can be done by rebuilding the list.
 *
 * A template with a span glued to text (`btn-${size}`) is not a token list and
 * keeps refusing.
 */
import type { TemplateExpression } from 'ts-morph'

export interface TemplateTokens {
  literals: readonly string[]
  expressions: readonly string[]
}

export type TemplateRebuild =
  | { kind: 'refuse' }
  | { kind: 'remove-attribute' }
  | { kind: 'string'; text: string }
  | { kind: 'expression'; text: string }
  | { kind: 'template'; text: string }

type Item = { kind: 'literal'; value: string } | { kind: 'expression'; value: string }

/** The template as an ordered token list, or `null` when a span is glued to text and the list is not readable. */
function readItems(template: TemplateExpression): Item[] | null {
  const items: Item[] = []
  const pieces = [template.getHead().getLiteralText(), ...template.getTemplateSpans().map((span) => span.getLiteral().getLiteralText())]
  const spans = template.getTemplateSpans()
  for (let index = 0; index < pieces.length; index += 1) {
    const text = pieces[index]!
    if (index > 0 && text !== '' && !/^\s/.test(text)) return null
    if (index < pieces.length - 1 && text !== '' && !/\s$/.test(text)) return null
    for (const token of text.split(/\s+/)) if (token !== '') items.push({ kind: 'literal', value: token })
    const span = spans[index]
    if (span) items.push({ kind: 'expression', value: span.getExpression().getText() })
  }
  return items
}

/** The template with `remove` taken out and `add` appended (a token already there is kept once). */
export function rebuildTemplateClassName(template: TemplateExpression, add: TemplateTokens, remove: TemplateTokens): TemplateRebuild {
  const items = readItems(template)
  if (items === null) return { kind: 'refuse' }
  const found = (list: readonly string[], kind: Item['kind']) =>
    list.every((value) => items.some((item) => item.kind === kind && item.value === value))
  if (!found(remove.literals, 'literal') || !found(remove.expressions, 'expression')) return { kind: 'refuse' }

  const kept = items.filter(
    (item) => !(item.kind === 'literal' ? remove.literals : remove.expressions).includes(item.value),
  )
  for (const literal of add.literals) if (!kept.some((item) => item.kind === 'literal' && item.value === literal)) kept.push({ kind: 'literal', value: literal })
  for (const expression of add.expressions) {
    if (!kept.some((item) => item.kind === 'expression' && item.value === expression)) kept.push({ kind: 'expression', value: expression })
  }

  if (kept.length === 0) return { kind: 'remove-attribute' }
  if (kept.every((item) => item.kind === 'literal')) return { kind: 'string', text: kept.map((item) => item.value).join(' ') }
  if (kept.length === 1) return { kind: 'expression', text: kept[0]!.value }
  return { kind: 'template', text: '`' + kept.map((item) => (item.kind === 'expression' ? '${' + item.value + '}' : item.value)).join(' ') + '`' }
}
