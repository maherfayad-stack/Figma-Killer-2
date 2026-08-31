/**
 * extractStringsToDictionary — rewrites hardcoded copy in ONE file into
 * dictionary lookups: `title="Profile verified"` becomes `title={t.pageProfileVerified}`,
 * with `const { t } = useLanguage()` added to the enclosing component and the
 * import added to the file.
 *
 * This is the write half of the Content panel's "set up English + Arabic"
 * action. `findHardcodedStrings` (server side) says WHICH literals are copy
 * and where; this says what the file looks like afterwards.
 *
 * ## Why the whole file at once, and not one string at a time
 *
 * A per-string codemod would re-parse the file, re-add the same import and
 * re-insert the same hook line for every literal — fifteen times for the
 * fifteen strings on one screen, each one racing the last one's positions.
 * Batching is not an optimisation here, it is what makes the import and the
 * hook a single decision per file instead of a merge conflict with itself.
 *
 * ## Positions are consumed in descending order
 *
 * Every edit is addressed by the `(line, col)` the scan reported, and applying
 * one shifts every position after it. Descending order means an edit never
 * invalidates the position of an edit not yet applied, so each target is
 * re-resolved from the live AST immediately before it is rewritten — the scan's
 * numbers are never trusted against a text this function has already changed.
 * The hook insertions and the import come last, for the same reason.
 *
 * ## What it refuses, per string, rather than guessing
 *
 * - **A literal outside any component function.** A module-scope const cannot
 *   call a hook, and hoisting it into one would move code the user wrote.
 * - **A literal whose text no longer matches the scan.** The file changed
 *   under us; rewriting the wrong node is worse than doing nothing.
 * - **A file that already binds `t`.** Studio would be shadowing a name that
 *   already means something here.
 *
 * A refusal is per string and named; the other strings in the same file still
 * land.
 */
import {
  Node,
  IndentationText,
  Project,
  QuoteKind,
  SyntaxKind,
  type ArrowFunction,
  type Block,
  type FunctionDeclaration,
  type FunctionExpression,
  type JsxAttribute,
  type SourceFile,
} from 'ts-morph'

/** One literal to replace, as `findHardcodedStrings` reported it plus the key it was assigned. */
export interface StringExtraction {
  /** 1-based line of the literal's own start. */
  line: number
  /** 1-based column. */
  col: number
  /** The exact text the scan read — re-checked against the live AST before anything is rewritten. */
  text: string
  /** Dot-addressed dictionary key (`page.profileVerified`). */
  key: string
}

export type ExtractionRefusalReason =
  | 'not-found'
  | 'text-changed'
  | 'outside-component'
  | 'name-taken'
  | 'invalid-key'

export interface ExtractionRefusal {
  key: string
  reason: ExtractionRefusalReason
  message: string
}

export interface ExtractStringsResult {
  /** The rewritten file, or the original text when nothing applied. */
  text: string
  /** Keys that were actually written into the JSX. */
  applied: string[]
  refused: ExtractionRefusal[]
}

export interface ExtractStringsParams {
  sourceText: string
  /** A filename ts-morph parses with the right syntax — only the extension matters. */
  fileName: string
  extractions: readonly StringExtraction[]
  /** Module specifier the hook is imported from, already resolved relative to this file. */
  importSpecifier: string
  /** Named export providing `{ t }` — `useLanguage` for Studio's own scaffold. */
  hookName: string
}

/** The accessor expression a key reads as: `t.page.profileVerified` for a dotted key. */
function accessorFor(key: string): string {
  return `t.${key}`
}

/**
 * Whether every segment of a dotted key is a valid JS identifier.
 *
 * The accessor is written as real source, so `t.home.2AdultsEconomy` is a
 * syntax error — and ts-morph rejects the whole FILE's manipulation when one
 * appears, taking down every other string in it. Checking here turns that into
 * one named per-string refusal. The key minter is responsible for not
 * producing these (`identifierSegment`); this is the guard that keeps a
 * mistake there from corrupting a user's file.
 */
function isWritableKey(key: string): boolean {
  const segments = key.split('.')
  return segments.length > 0 && segments.every((segment) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment))
}

/**
 * The OUTERMOST function-like ancestor that sits directly at the file's top
 * level — the component whose body may hold the hook call. A literal inside a
 * nested callback still belongs to the component that encloses the callback,
 * which is why this walks all the way out rather than stopping at the first
 * function it meets.
 */
function enclosingComponentBody(node: Node): Block | undefined {
  let outermost: ArrowFunction | FunctionDeclaration | FunctionExpression | undefined
  for (let current = node.getParent(); current !== undefined; current = current.getParent()) {
    if (Node.isFunctionDeclaration(current) || Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      outermost = current
    }
  }
  const body = outermost?.getBody()
  return body && Node.isBlock(body) ? body : undefined
}

/** The string literal or JSX text at a 1-based `(line, col)`, or `undefined` when the file no longer has one there. */
function nodeAt(sourceFile: SourceFile, line: number, col: number): Node | undefined {
  let pos: number
  try {
    pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, col - 1)
  } catch {
    return undefined
  }
  const node = sourceFile.getDescendantAtPos(pos)
  if (!node) return undefined
  if (Node.isStringLiteral(node) || Node.isJsxText(node)) return node
  // `getDescendantAtPos` can land on the token inside the literal.
  const parent = node.getParent()
  return parent && (Node.isStringLiteral(parent) || Node.isJsxText(parent)) ? parent : undefined
}

/** The `JsxAttribute` this string literal is the whole value of, or `undefined` (an object-literal property, a call argument). */
function owningAttribute(literal: Node): JsxAttribute | undefined {
  const parent = literal.getParent()
  return parent && Node.isJsxAttribute(parent) && parent.getInitializer() === literal ? parent : undefined
}

/** Rewrites one located node in place. Returns `false` when the node's shape is one this codemod does not write. */
function replaceWithAccessor(node: Node, key: string): boolean {
  const accessor = accessorFor(key)

  if (Node.isJsxText(node)) {
    // The surrounding whitespace is layout, not copy — the scan trimmed the
    // text it reported, so only the trimmed span is replaced and the
    // indentation the author wrote survives.
    const full = node.getText()
    const leading = full.slice(0, full.length - full.trimStart().length)
    const trailing = full.slice(full.trimEnd().length)
    node.replaceWithText(`${leading}{${accessor}}${trailing}`)
    return true
  }

  const attribute = owningAttribute(node)
  if (attribute) {
    attribute.setInitializer(`{${accessor}}`)
    return true
  }

  // A literal in expression position — an object-literal property value
  // (`toolbar={{ title: 'Account' }}`), a ternary branch. The accessor is a
  // plain expression there, so no braces.
  if (Node.isStringLiteral(node)) {
    node.replaceWithText(accessor)
    return true
  }
  return false
}

/**
 * Whether `name` is bound in this file by something OTHER than the extraction
 * hook itself.
 *
 * The exclusion is the whole point. A second extraction run — a screen written
 * after the first, a string the scanner learned to see later — lands in a file
 * that already carries `const { t } = useLanguage()` from the first run, and a
 * plain "is `t` bound?" check reads Studio's own previous edit as a conflict
 * and refuses every string in the file. Measured: on the real `untitled-2`
 * that was 9 of 9 refused with "already binds t", which looks exactly like a
 * scanner failure and is not one.
 *
 * Deliberately file-wide rather than scope-accurate otherwise: a `t` bound in
 * a sibling component is not a real conflict, but treating it as one costs a
 * named refusal, while getting scope analysis subtly wrong costs the user a
 * shadowed binding they never asked for.
 */
function bindsNameElsewhere(sourceFile: SourceFile, name: string, hookName: string): boolean {
  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() === name) return true
    if (decl.getNamedImports().some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name)) return true
  }
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => {
      if (identifier.getText() !== name) return false
      const parent = identifier.getParent()
      if (!Node.isVariableDeclaration(parent) && !Node.isBindingElement(parent) && !Node.isParameterDeclaration(parent)) {
        return false
      }
      // `const { t } = useLanguage()` is this codemod's own previous output,
      // not a name to refuse over.
      const declaration = identifier.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
      return declaration?.getInitializer()?.getText().startsWith(`${hookName}(`) !== true
    })
}

/** Adds `const { t } = useLanguage()` as the first statement of a component body that has not got it yet. */
function ensureHookCall(body: Block, hookName: string): void {
  const already = body.getStatements().some((statement) => statement.getText().includes(`${hookName}()`))
  if (already) return
  body.insertStatements(0, `const { t } = ${hookName}()`)
}

/**
 * Adds the named hook import when the file does not already import it,
 * matching the file's own semicolon style. ts-morph always emits a terminating
 * `;`, which is a visible foreign edit in the (common) corpus file that uses
 * none — and the smallest kind of diff noise to leave in somebody's repo.
 */
function ensureImport(sourceFile: SourceFile, specifier: string, hookName: string, semicolons: boolean): void {
  const existing = sourceFile.getImportDeclaration((decl) => decl.getModuleSpecifierValue() === specifier)
  if (existing) {
    if (!existing.getNamedImports().some((n) => n.getNameNode().getText() === hookName)) {
      existing.addNamedImport(hookName)
    }
    return
  }
  const added = sourceFile.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [hookName] })
  if (!semicolons) added.replaceWithText(added.getText().replace(/;$/, ''))
}

/** Whether this file terminates its own import statements with `;`. `true` when it has no imports to read a style from. */
function usesSemicolons(sourceFile: SourceFile): boolean {
  const imports = sourceFile.getImportDeclarations()
  return imports.length === 0 || imports.some((decl) => decl.getText().endsWith(';'))
}

export function extractStringsToDictionary(params: ExtractStringsParams): ExtractStringsResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    // The generated import and hook line land in a file the user wrote, so
    // they match the corpus's own style rather than ts-morph's defaults.
    manipulationSettings: { quoteKind: QuoteKind.Single, indentationText: IndentationText.TwoSpaces },
  })
  const sourceFile = project.createSourceFile(params.fileName, params.sourceText)

  if (bindsNameElsewhere(sourceFile, 't', params.hookName)) {
    return {
      text: params.sourceText,
      applied: [],
      refused: params.extractions.map((extraction) => ({
        key: extraction.key,
        reason: 'name-taken' as const,
        message: `${params.fileName} already binds "t", so Studio won't shadow it.`,
      })),
    }
  }

  const semicolons = usesSemicolons(sourceFile)
  const applied: string[] = []
  const refused: ExtractionRefusal[] = []
  const componentBodyStarts = new Set<number>()

  // Descending, so an applied edit never moves a target still to come.
  const ordered = [...params.extractions].sort((a, b) => b.line - a.line || b.col - a.col)

  for (const extraction of ordered) {
    if (!isWritableKey(extraction.key)) {
      refused.push({
        key: extraction.key,
        reason: 'invalid-key',
        message: `"${extraction.key}" is not a valid property path, so Studio won't write it into the source.`,
      })
      continue
    }
    const node = nodeAt(sourceFile, extraction.line, extraction.col)
    if (!node) {
      refused.push({ key: extraction.key, reason: 'not-found', message: `No string literal at ${params.fileName}:${extraction.line}.` })
      continue
    }
    const current = Node.isJsxText(node)
      ? node.getLiteralText().trim()
      : Node.isStringLiteral(node)
        ? node.getLiteralValue()
        : undefined
    if (current !== extraction.text) {
      refused.push({ key: extraction.key, reason: 'text-changed', message: `The text at ${params.fileName}:${extraction.line} changed since it was scanned.` })
      continue
    }
    const body = enclosingComponentBody(node)
    if (!body) {
      refused.push({ key: extraction.key, reason: 'outside-component', message: `"${extraction.text}" is outside any component, so it cannot read a hook.` })
      continue
    }
    const bodyStart = body.getStart()
    if (!replaceWithAccessor(node, extraction.key)) {
      refused.push({ key: extraction.key, reason: 'not-found', message: `Studio does not know how to rewrite the literal at ${params.fileName}:${extraction.line}.` })
      continue
    }
    componentBodyStarts.add(bodyStart)
    applied.push(extraction.key)
  }

  if (applied.length === 0) return { text: params.sourceText, applied, refused }

  // Same descending discipline: inserting a statement moves everything after it.
  for (const start of [...componentBodyStarts].sort((a, b) => b - a)) {
    const block = sourceFile.getDescendantsOfKind(SyntaxKind.Block).find((candidate) => candidate.getStart() === start)
    if (block) ensureHookCall(block, params.hookName)
  }

  ensureImport(sourceFile, params.importSpecifier, params.hookName, semicolons)

  return { text: sourceFile.getFullText(), applied: applied.reverse(), refused }
}
