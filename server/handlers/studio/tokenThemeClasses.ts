/**
 * tokenThemeClasses - where a project's source SPELLS a Tailwind theme name as
 * a utility class, and how to move it (CT-6).
 *
 * `--color-brand` in `@theme` is also the class vocabulary `bg-brand`,
 * `text-brand`, `hover:border-brand/50` (`@core/studio-tokens`
 * `themeUtilities.ts` is the table). A rename that moved only the variable
 * would leave every one of those classes naming nothing, so the rename planner
 * (`tokenRefactor.ts`) rewrites them in the same plan, and one undo puts them
 * back.
 *
 * ## Where a class is looked for
 *
 * Only where a class can actually be:
 *
 *   - in a script file (`.ts .tsx .js .jsx .mjs .cjs`), inside a string
 *     literal or a template literal's text - found from the parsed syntax tree,
 *     never from a regex over the whole file, so an identifier, a comment or a
 *     JSX text node that happens to read `text-brand` is left alone;
 *   - in a `.css` file, inside an `@apply` statement - a `.bg-brand { ... }`
 *     rule the author wrote is THEIR class, not a use of the theme's.
 *
 * Any other file type that holds a use (`.html`, `.vue`, `.scss`...) is counted
 * but not rewritten: the undo journal cannot take those back, so the planner
 * refuses rather than write something Cmd+Z cannot restore.
 *
 * ## What it cannot follow
 *
 * A class built at runtime (`` `bg-${tone}` ``, `"bg-" + tone`) names no
 * literal. Those sites are reported (`dynamic`, with their lines) so the
 * caller can say so instead of leaving a silently dangling class. Parse only:
 * nothing is evaluated.
 */
import { ts } from 'ts-morph'
import { classWordsOf, rewriteClassWords, themeClassNames, themeClassStems, type ThemeNamespace } from '@core/studio-tokens'

const SCRIPT_FILE_RE = /\.(?:tsx?|jsx?|mjs|cjs)$/i
const CSS_FILE_RE = /\.css$/i
const TYPESCRIPT_ONLY_RE = /\.(?:ts|mts|cts)$/i
const APPLY_STATEMENT_RE = /@apply\b[^;{}]*/g

export interface ThemeClassScan {
  /** The text with every use moved (`toKey` given), otherwise unchanged. */
  readonly text: string
  /** Whole-class uses of the old key: the ones rewritten, or merely counted. */
  readonly count: number
  /** 1-based lines where a class of this namespace is built at runtime (`bg-${...}`), which no rename can follow. */
  readonly dynamic: readonly number[]
}

export function isScriptFile(file: string): boolean {
  return SCRIPT_FILE_RE.test(file)
}

export function isApplyHostFile(file: string): boolean {
  return CSS_FILE_RE.test(file)
}

interface Segment {
  /** Offsets of the literal's text, between its quotes or template punctuation. */
  readonly start: number
  readonly end: number
  /** The text is followed by a computed part (`${...}` or `+ expr`), so a class may continue past its end. */
  readonly continues: boolean
}

function literalSegments(file: string, text: string): { segments: Segment[]; lineOf: (offset: number) => number } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, TYPESCRIPT_ONLY_RE.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.TSX)
  const segments: Segment[] = []
  const visit = (node: ts.Node): void => {
    const start = node.getStart(source)
    const end = node.getEnd()
    if (ts.isStringLiteral(node)) {
      const parent = node.parent
      const continues = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken && parent.left === node
      segments.push({ start: start + 1, end: end - 1, continues })
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      segments.push({ start: start + 1, end: end - 1, continues: false })
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      segments.push({ start: start + 1, end: end - 2, continues: true })
    } else if (ts.isTemplateTail(node)) {
      segments.push({ start: start + 1, end: end - 1, continues: false })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { segments, lineOf: (offset) => source.getLineAndCharacterOfPosition(offset).line + 1 }
}

/** The class-bearing text of a file: each script string segment, or each `@apply` statement, with where it starts. */
function classTexts(file: string, text: string): { texts: Array<{ start: number; end: number; continues: boolean }>; lineOf: (offset: number) => number } {
  if (isScriptFile(file)) {
    const { segments, lineOf } = literalSegments(file, text)
    return { texts: segments.filter((segment) => segment.end > segment.start), lineOf }
  }
  const texts = [...text.matchAll(APPLY_STATEMENT_RE)].map((match) => ({ start: match.index, end: match.index + match[0].length, continues: false }))
  return { texts, lineOf: (offset) => text.slice(0, offset).split('\n').length }
}

/**
 * The uses of the theme key `fromKey` (of `namespace`) as a utility class in
 * one file. With `toKey` the returned text has them moved; without it the text
 * is the input and only the count is meaningful. Never throws: a file that
 * cannot be parsed yields what the parser could read.
 */
export function scanThemeClasses(file: string, text: string, namespace: ThemeNamespace, fromKey: string, toKey: string | null): ThemeClassScan {
  if (namespace.utilities.length === 0) return { text, count: 0, dynamic: [] }
  const from = new Set(themeClassNames(namespace, fromKey))
  if (!isScriptFile(file) && !isApplyHostFile(file)) {
    // Any other file type is never rewritten (no undo can take it back): count only.
    return { text, count: classWordsOf(text).filter((word) => from.has(word.name)).length, dynamic: [] }
  }
  const stems = new Set(themeClassStems(namespace))
  const { texts, lineOf } = classTexts(file, text)
  const dynamic: number[] = []
  const edits: Array<{ start: number; end: number; text: string }> = []
  let count = 0
  for (const segment of texts) {
    const literal = text.slice(segment.start, segment.end)
    if (segment.continues && classWordsOf(literal).some((word) => stems.has(word.name) && word.end === literal.length)) dynamic.push(lineOf(segment.start))
    if (toKey === null) {
      count += classWordsOf(literal).filter((word) => from.has(word.name)).length
      continue
    }
    const rewritten = rewriteClassWords(literal, (name) => {
      if (!from.has(name)) return null
      return `${name.slice(0, name.length - fromKey.length)}${toKey}`
    })
    if (rewritten.count === 0) continue
    count += rewritten.count
    edits.push({ start: segment.start, end: segment.end, text: rewritten.text })
  }
  let next = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  return { text: next, count, dynamic }
}

/**
 * Every use of a theme utility class in one file, for the usage count: which
 * variable it reads (`byClass` maps `bg-brand` -> [`--color-brand`]) and the
 * line. Same class definition as the rename, so a count of 0 means a rename or
 * removal has nothing to follow.
 */
export function themeClassUsage(file: string, text: string, byClass: ReadonlyMap<string, readonly string[]>): Array<{ token: string; line: number }> {
  const uses: Array<{ token: string; line: number }> = []
  const literal = isScriptFile(file) || isApplyHostFile(file)
  const { texts, lineOf } = literal
    ? classTexts(file, text)
    : { texts: [{ start: 0, end: text.length, continues: false }], lineOf: (offset: number) => text.slice(0, offset).split('\n').length }
  for (const segment of texts) {
    const body = text.slice(segment.start, segment.end)
    for (const word of classWordsOf(body)) {
      for (const token of byClass.get(word.name) ?? []) uses.push({ token, line: lineOf(segment.start + word.start) })
    }
  }
  return uses
}
