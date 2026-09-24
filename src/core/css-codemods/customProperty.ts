/**
 * Custom-property (design token) declarations — find every one, and rewrite
 * the value of exactly one (AI-15, `studio_set_tokens`).
 *
 * The other codemods in this folder address a declaration by `(selector,
 * property)`. A design token cannot be addressed that way honestly: the same
 * `--brand` is routinely declared under `:root` AND under a dark-scheme gate
 * (`[data-theme="dark"]`, `.dark`, `@media (prefers-color-scheme: dark)`), and
 * sometimes again inside a responsive `@media`. Which of those is "the"
 * token is a scan question — the server's root-scope token scan
 * (`collectRootScopeDeclarations`) already answers it for the canvas, and
 * reports the winning declaration's LINE. So this module takes the line, and
 * does two things only:
 *
 *   - {@link listCustomPropertyDeclarations} — every declaration of one name
 *     in the file, with its line and the selector/at-rule context it sits in,
 *     so a caller can see that a token has more than one declaration and
 *     refuse instead of guessing which one the user meant;
 *   - {@link setCustomPropertyValueAtLine} — rewrite the value of the ONE
 *     declaration of that name that starts on that line.
 *
 * Same CST contract as `setDeclaration`: postcss round-trip, every untouched
 * byte (comments, indentation, `!important`, the other scheme's value) kept,
 * the file's own line ending restored (`preservingLineEndings`). Line numbers
 * survive the LF normalisation unchanged — CRLF → LF removes a character per
 * line, never a line.
 *
 * Pure text-in/text-out, no filesystem, like every codemod here. The value is
 * validated by parsing it back as a declaration: a value carrying `;`, `{` or
 * `}` would otherwise land as a second declaration or a broken block, which is
 * a change nobody asked for.
 */
import postcss, { type Declaration, type Node, type Root } from 'postcss'
import { toLf } from '@core/utils/lineEndings'
import { preservingLineEndings } from './preserveLineEndings'

/** One declaration of a custom property, where it is and what encloses it. */
export interface CustomPropertyDeclaration {
  /** 1-based line the declaration starts on. */
  readonly line: number
  /** The value as written (raw), trimmed. */
  readonly value: string
  /** The selector of the enclosing rule, or `null` for a declaration outside any rule. */
  readonly selector: string | null
  /** Enclosing at-rules, outermost first, as `@name params` — `['@media (prefers-color-scheme: dark)']`. */
  readonly atRules: readonly string[]
}

export type CustomPropertyEditResult =
  | { readonly ok: true; readonly css: string; readonly changed: boolean; readonly previous: string }
  | { readonly ok: false; readonly reason: 'not-a-custom-property' | 'invalid-value' | 'no-declaration-at-line' | 'unparseable-stylesheet'; readonly message: string }

const CUSTOM_PROPERTY_NAME_RE = /^--[A-Za-z0-9_-]+$/

function contextOf(decl: Declaration): { selector: string | null; atRules: string[] } {
  let selector: string | null = null
  const atRules: string[] = []
  let parent: Node | undefined = decl.parent as Node | undefined
  while (parent && parent.type !== 'root') {
    if (parent.type === 'rule' && selector === null) selector = (parent as postcss.Rule).selector.trim()
    if (parent.type === 'atrule') {
      const at = parent as postcss.AtRule
      atRules.unshift(`@${at.name}${at.params ? ` ${at.params.trim()}` : ''}`)
    }
    parent = parent.parent as Node | undefined
  }
  return { selector, atRules }
}

function parse(cssText: string): Root | null {
  try {
    return postcss.parse(cssText)
  } catch {
    return null
  }
}

/**
 * Every declaration of `name` in `cssText`, in source order. Empty for a file
 * that does not declare it — and for one postcss cannot parse, which a caller
 * that goes on to write must treat as a refusal (the setter reports it).
 */
export function listCustomPropertyDeclarations(cssText: string, name: string): CustomPropertyDeclaration[] {
  const root = parse(cssText)
  if (!root) return []
  const found: CustomPropertyDeclaration[] = []
  root.walkDecls(name, (decl) => {
    const { selector, atRules } = contextOf(decl)
    found.push({ line: decl.source?.start?.line ?? 0, value: decl.value.trim(), selector, atRules })
  })
  return found
}

/** `null` when `value` is a single, well-formed declaration value; otherwise why not. */
function invalidValueReason(name: string, value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'the value is empty'
  if (/[\r\n]/.test(trimmed)) return 'the value spans more than one line'
  if (/[;{}]/.test(trimmed)) return 'the value contains ";", "{" or "}", which would end the declaration or open a block'
  const parsedValues: string[] = []
  parse(`:root { ${name}: ${trimmed}; }`)?.walkDecls((decl) => {
    parsedValues.push(decl.value.trim())
  })
  if (parsedValues.length !== 1 || parsedValues[0] !== trimmed) return 'the value does not parse back as exactly this one declaration'
  return null
}

/**
 * Set the value of the ONE declaration of `name` that starts on `line`.
 * Refuses (never guesses) when there is no such declaration there — the file
 * moved on since it was scanned — or when the value would not survive as one
 * declaration. A value already in place is `changed: false` with the caller's
 * own bytes back.
 */
export function setCustomPropertyValueAtLine(cssText: string, name: string, line: number, value: string): CustomPropertyEditResult {
  if (!CUSTOM_PROPERTY_NAME_RE.test(name)) {
    return { ok: false, reason: 'not-a-custom-property', message: `"${name}" is not a CSS custom property name (it must start with "--").` }
  }
  const invalid = invalidValueReason(name, value)
  if (invalid) return { ok: false, reason: 'invalid-value', message: `The value for ${name} was not written: ${invalid}.` }
  const next = value.trim()

  // Located on the LF-normalised text `preservingLineEndings` will hand the
  // rewrite — same line numbers, since normalising never removes a line.
  const root = parse(toLf(cssText))
  if (!root) {
    return { ok: false, reason: 'unparseable-stylesheet', message: `The stylesheet declaring ${name} does not parse as CSS, so no declaration in it can be edited safely.` }
  }
  const atLine = declarationsAtLine(root, name, line)
  if (atLine.length !== 1) {
    return {
      ok: false,
      reason: 'no-declaration-at-line',
      message: atLine.length === 0
        ? `No declaration of ${name} starts on line ${line} any more — the file changed since it was read.`
        : `Line ${line} holds ${atLine.length} declarations of ${name}, so it does not name one.`,
    }
  }
  const previous = atLine[0]!.value.trim()

  const rewrite = preservingLineEndings(cssText, (source) => {
    const fresh = postcss.parse(source)
    const decl = declarationsAtLine(fresh, name, line)[0]!
    if (decl.value.trim() === next) return { css: source, changed: false }
    decl.value = next
    return { css: fresh.toString(), changed: true }
  })
  return { ok: true, css: rewrite.css, changed: rewrite.changed, previous }
}

function declarationsAtLine(root: Root, name: string, line: number): Declaration[] {
  const atLine: Declaration[] = []
  root.walkDecls(name, (decl) => {
    if (decl.source?.start?.line === line) atLine.push(decl)
  })
  return atLine
}
