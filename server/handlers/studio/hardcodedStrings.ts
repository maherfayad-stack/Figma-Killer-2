/**
 * hardcodedStrings — every user-visible string literal sitting in a project's
 * JSX, with the exact source location a later extraction would rewrite.
 *
 * This is the other half of the Content panel. `translationCatalog.ts` answers
 * "what does this project's dictionary say" — the right question for a project
 * that HAS one. A project with none (`locales: null`) still has all its copy;
 * it is just written inline, as `title="Profile verified"` and `<h2>Account</h2>`.
 * Without this scan the panel could only tell such a project it had nothing,
 * which is the opposite of the truth.
 *
 * ## What counts as user-visible, and why the filter is aggressive
 *
 * A JSX file is full of string literals that are not copy: class names,
 * variant tokens (`type="success"`), URLs, test ids, enum-ish props. Offering
 * those for translation is worse than offering nothing — it buries the
 * sentences a user actually wants to translate under noise, and a translated
 * `variant="primary"` breaks the app.
 *
 * So a literal is only reported when it looks like a sentence a person reads:
 * it contains a space or is long enough to be a word rather than a token, it
 * has at least one letter, and it is not on a prop this file knows carries
 * machinery rather than prose ({@link NON_COPY_PROPS}). JSX text nodes are
 * reported on the same terms. The bias is deliberately toward MISSING a
 * string over inventing one: a missed string is visible (the user can see it
 * on the canvas and say so), while a false positive silently invites a
 * destructive edit.
 *
 * **Parse, never execute** — ts-morph reads the written AST. A string built at
 * runtime is not here at all, which is honest: Studio could not have
 * extracted it anyway.
 */
import { join } from 'node:path'
import { Node, Project, SyntaxKind, type JsxExpression, type SourceFile } from 'ts-morph'
import { listWorkspaceFiles } from '@core/page-parser'
import { readTextCapped } from './cappedFileRead'
import { resolveAppRoot } from './appRoot'

const MAX_FILE_BYTES = 300_000
const MAX_STRINGS = 500

/** Props whose value is machinery, not prose. A translated `variant` or `href` is a broken app. */
const NON_COPY_PROPS = new Set([
  'className', 'class', 'id', 'key', 'href', 'src', 'to', 'type', 'variant', 'size', 'color',
  'name', 'role', 'target', 'rel', 'style', 'width', 'height', 'dir', 'lang', 'slot',
  'visual', 'trailing', 'leading', 'surface', 'bg', 'platform', 'iconSrc', 'testId', 'data-testid',
])

/**
 * Props that are machinery on a HOST element and copy on a component.
 *
 * `value` is the whole reason this distinction exists. On `<input>`/`<option>`
 * it is form state and translating it changes what the form submits; on a
 * `<Cell>` it is the text rendered down the right-hand side of the row, and
 * on the real `untitled-2` that meant `Dubai (DXB)`, `Jeddah (JED)`,
 * `Aug 28 – 11`, `English` and `SAR` were all invisible to this scan. The tag
 * is what tells them apart: a lowercase tag is a DOM element, a capitalised
 * one is a component whose props are whatever its author decided.
 */
const HOST_ONLY_NON_COPY_PROPS = new Set(['value', 'placeholder'])

/** Whether `tagName` is a host element (`div`, `input`) rather than a component (`Cell`, `Navbar`). */
function isHostElement(tagName: string): boolean {
  const first = tagName[0]
  return first !== undefined && first === first.toLowerCase()
}

/** The tag name of the element an attribute belongs to (`Cell` for `<Cell value="…" />`). */
function owningTagName(attribute: Node): string {
  const parent = attribute.getParent()
  if (Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent)) {
    return parent.getTagNameNode().getText()
  }
  const grandparent = parent?.getParent()
  if (grandparent && (Node.isJsxOpeningElement(grandparent) || Node.isJsxSelfClosingElement(grandparent))) {
    return grandparent.getTagNameNode().getText()
  }
  return ''
}

/**
 * A literal inside an `<svg>` is geometry, never copy — and it is exactly the
 * shape that defeats a content heuristic: a path's `d` is long, contains
 * spaces and contains letters, so it passes every "looks like a sentence"
 * test there is. Measured on `untitled-2`: 4 of the first 14 hits were path
 * data before this rule, each one hundreds of characters long, which would
 * have buried the six real strings on the same screen.
 *
 * Excluding the whole subtree rather than blacklisting `d`/`viewBox`/`points`
 * one attribute at a time is what makes this hold for the next SVG attribute
 * nobody thought of.
 */
function insideSvg(node: Node): boolean {
  for (
    let ancestor = node.getParent();
    ancestor !== undefined;
    ancestor = ancestor.getParent()
  ) {
    if (Node.isJsxElement(ancestor)) {
      if (ancestor.getOpeningElement().getTagNameNode().getText().toLowerCase() === 'svg') return true
      continue
    }
    if (Node.isJsxSelfClosingElement(ancestor) && ancestor.getTagNameNode().getText().toLowerCase() === 'svg') {
      return true
    }
  }
  return false
}

/**
 * Digit-dominated content is coordinates, ids or measurements rather than a
 * sentence — a second line of defence behind {@link insideSvg} for geometry
 * written outside an `<svg>`.
 *
 * A real WORD rescues it, though: `Aug 28 – 11` is 36% digits and is a date a
 * reader sees on screen, while `0 0 24 24` and `M12.0001 3.5C7.3` are not.
 * Three consecutive letters is the line — enough for `Aug`, `SAR` or `adults`,
 * and not something path data produces.
 */
function isDigitDominated(trimmed: string): boolean {
  const digits = (trimmed.match(/[0-9]/g) ?? []).length
  if (digits / trimmed.length <= 0.3) return false
  return !/\p{L}{3}/u.test(trimmed)
}

/** What every copy test shares: has a letter, is not a path/url/template, is not geometry. */
function isReadableText(trimmed: string): boolean {
  if (trimmed.length < 2) return false
  if (!/\p{L}/u.test(trimmed)) return false
  if (/^(https?:\/\/|\/|\.\/|#|\{)/.test(trimmed)) return false
  return !isDigitDominated(trimmed)
}

/**
 * Copy in CHILD position — `<h3>Account</h3>`, `<h3>{"Account"}</h3>`.
 *
 * By definition this is rendered to the reader: there is no prop whose name
 * could make it machinery, so the identifier heuristic {@link looksLikeCopy}
 * needs has nothing to protect against here and only does harm. On the real
 * `untitled-2` it discarded `asdasdasdas` and `asdfasdfasdfasd` — placeholder
 * copy the user had typed onto the canvas and could see on screen, which is
 * the most obvious thing to want to translate and the least defensible thing
 * to hide.
 */
function looksLikeRenderedCopy(text: string): boolean {
  return isReadableText(text.trim())
}

/**
 * Copy in PROP position, where a literal may well be machinery.
 *
 * Multi-word text is copy. A SINGLE word is the hard case and casing is the
 * discriminator: real UI copy is capitalised (`From`, `Dates`, `Install`)
 * while an enum token is not (`primary`, `solid`, `chevron`). Rejecting every
 * short single word — the first version of this rule — silently dropped the
 * shortest and commonest labels on a screen, which is exactly the copy a
 * translator needs most.
 */
function looksLikeCopy(text: string): boolean {
  const trimmed = text.trim()
  if (!isReadableText(trimmed)) return false
  if (/\s/.test(trimmed)) return true
  // Plainly an identifier, a slug or a CSS value, whatever its length.
  if (/^[a-z0-9_-]+$/.test(trimmed)) return false
  // Anything else short must be capitalised to count as a word someone reads.
  return trimmed.length >= 12 || /^\p{Lu}/u.test(trimmed)
}

export interface HardcodedString {
  /** Workspace-relative POSIX path. */
  file: string
  /** 1-based, the literal's own start — the location an extraction rewrites. */
  line: number
  col: number
  /** The prop this literal is the value of, or `null` for a JSX text child. */
  prop: string | null
  text: string
}

/**
 * Copy written inside a prop's EXPRESSION rather than as its whole value:
 * `toolbar={{ variant: 'default', title: 'Account' }}`, `items={['Flights', 'Stays']}`.
 *
 * This is not an exotic shape — it is how this corpus's design system takes
 * structured props, so a scan that only read `prop="…"` reported nothing at
 * all for a `<Navbar>`'s title while reporting every `<Cell>`'s label beside
 * it. The literals are as translatable as any other, and the extraction
 * codemod already rewrites a literal in expression position.
 *
 * Two exclusions: an object key that is itself machinery (`variant`, `type`)
 * is skipped by the same {@link NON_COPY_PROPS} list the attribute name goes
 * through, and anything inside a function is behaviour rather than copy
 * (`onClick={() => track('cta')}`).
 */
function collectNestedCopy(
  sourceFile: SourceFile,
  relPath: string,
  attributeName: string,
  expression: JsxExpression,
  out: HardcodedString[],
): void {
  for (const literal of expression.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    if (out.length >= MAX_STRINGS) return
    if (literal.getFirstAncestor((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a))) continue
    // The attribute itself is not inside an `<svg>`, but its VALUE can hold
    // one — `icon={<><ChevronIcon /><svg stroke="currentColor" …/></>}` is the
    // shape in this corpus — so geometry is excluded per literal, not per prop.
    if (insideSvg(literal)) continue

    const property = literal.getFirstAncestorByKind(SyntaxKind.PropertyAssignment)
    // The key this literal sits under — `toolbar.title` — or the attribute
    // itself for an array element.
    const ownKey = property?.getNameNode().getText().replace(/['"]/g, '')
    if (ownKey && NON_COPY_PROPS.has(ownKey)) continue
    if (property && property.getInitializer() !== literal) continue

    const value = literal.getLiteralValue()
    if (!looksLikeCopy(value)) continue
    const { line, column } = sourceFile.getLineAndColumnAtPos(literal.getStart())
    out.push({ file: relPath, line, col: column, prop: ownKey ? `${attributeName}.${ownKey}` : attributeName, text: value })
  }
}

function scanFile(absPath: string, relPath: string, out: HardcodedString[]): void {
  const text = readTextCapped(absPath, MAX_FILE_BYTES)
  if (text === undefined) return

  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sourceFile = project.createSourceFile('scan.tsx', text)

  for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (out.length >= MAX_STRINGS) return
    const name = attribute.getNameNode().getText()
    if (NON_COPY_PROPS.has(name)) continue
    if (HOST_ONLY_NON_COPY_PROPS.has(name) && isHostElement(owningTagName(attribute))) continue
    const initializer = attribute.getInitializer()
    if (!initializer) continue
    if (insideSvg(attribute)) continue

    if (Node.isStringLiteral(initializer)) {
      const value = initializer.getLiteralValue()
      if (!looksLikeCopy(value)) continue
      const { line, column } = sourceFile.getLineAndColumnAtPos(initializer.getStart())
      out.push({ file: relPath, line, col: column, prop: name, text: value })
      continue
    }
    if (Node.isJsxExpression(initializer)) collectNestedCopy(sourceFile, relPath, name, initializer, out)
  }

  // A string literal in CHILD position — `<h3>{"Account"}</h3>`. Rendered to
  // the reader exactly like a JSX text child, and it is how a placeholder gets
  // typed on the canvas, so a scan that read only bare text missed every one
  // of them.
  for (const container of sourceFile.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
    if (out.length >= MAX_STRINGS) return
    if (Node.isJsxAttribute(container.getParent())) continue // handled above
    const expression = container.getExpression()
    if (!expression || !Node.isStringLiteral(expression)) continue
    const value = expression.getLiteralValue()
    if (!looksLikeRenderedCopy(value) || insideSvg(container)) continue
    const { line, column } = sourceFile.getLineAndColumnAtPos(expression.getStart())
    out.push({ file: relPath, line, col: column, prop: null, text: value })
  }

  for (const jsxText of sourceFile.getDescendantsOfKind(SyntaxKind.JsxText)) {
    if (out.length >= MAX_STRINGS) return
    const value = jsxText.getLiteralText()
    if (!looksLikeRenderedCopy(value.trim()) || insideSvg(jsxText)) continue
    const { line, column } = sourceFile.getLineAndColumnAtPos(jsxText.getStart())
    out.push({ file: relPath, line, col: column, prop: null, text: value.trim() })
  }
}

/**
 * Every copy-shaped string literal in the project's own `.tsx`/`.jsx` files,
 * sorted by file then position. Never throws — an unreadable or unparsable
 * file contributes nothing.
 */
export function findHardcodedStrings(dir: string): HardcodedString[] {
  const appRootAbs = resolveAppRoot(dir)
  const out: HardcodedString[] = []
  for (const relFile of listWorkspaceFiles(appRootAbs)) {
    if (out.length >= MAX_STRINGS) break
    if (!/\.(tsx|jsx)$/.test(relFile)) continue
    try {
      scanFile(join(appRootAbs, ...relFile.split('/')), relFile, out)
    } catch {
      // A file ts-morph cannot parse contributes nothing, same posture as
      // every other best-effort scan in this folder.
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col)
}
