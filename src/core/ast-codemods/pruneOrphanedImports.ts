/**
 * pruneOrphanedImports — the second half of "delete this element", run once
 * per file after a whole save batch has landed.
 *
 * ## Why this is not inside `deleteJsxElement`
 *
 * Removing markup can leave an import with no remaining references, and under
 * `noUnusedLocals` — which real projects turn on — that is a build failure. So
 * a delete that stops at the element hands the user a repository that no
 * longer compiles. The import has to go with it.
 *
 * It cannot go with it *inside the codemod*, for two reasons that both come
 * from the batch:
 *
 *  1. **Line arithmetic.** `orderStudioEditsForApply` applies a batch
 *     bottom-to-top precisely so one edit can never move another's pending
 *     `line:col`. An import lives at the TOP of the file, so deleting its line
 *     mid-batch shifts every edit still queued below it — the exact failure
 *     that ordering exists to prevent, reintroduced from above.
 *  2. **Correctness.** A binding used by two elements being deleted in the
 *     same batch is orphaned by neither one alone. Asked per edit, each looks
 *     at the other's still-present markup and concludes the import is live, so
 *     nothing is pruned and the build breaks anyway. The question is only
 *     answerable once every edit has landed.
 *
 * ## What it will not touch
 *
 * An import that was ALREADY unused before the batch. That is the user's line,
 * not something this edit created, and deleting it would be the codemod
 * changing bytes nobody pointed at. Hence the two-phase shape: snapshot which
 * bindings are live BEFORE, prune only those that stopped being live.
 *
 * Reads references conservatively — any identifier of the same name outside an
 * import declaration counts as a use, including an object key or a property
 * access that is not really this binding. The failure mode is a leftover
 * import, never a deleted one that was still needed.
 *
 * ## `store-15` — what it hands back for an undo
 *
 * A pruned import is a second thing a delete's ⌘Z has to restore, alongside
 * the element itself. `prune()` returns not just which bindings it removed
 * but a re-insertable declaration TEXT per one (`PrunedImportsResult`), so the
 * caller can splice it back in without re-deriving how the binding was
 * originally spelled.
 */
import { SyntaxKind, type SourceFile } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import { applyTextEdits, ownedTextRange, verbatimSourceText, writeVerbatimSource, type TextEdit } from './jsxChildRange'

/** Files this pass understands. A batch's touched-file set also contains stylesheets. */
const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/

export function isPrunableSourceFile(file: string): boolean {
  return SOURCE_FILE_RE.test(file)
}

/**
 * `store-15` — what one file's prune pass removed, for a caller that needs to
 * put a pruned import back (an undo of the delete that orphaned it).
 *
 * `declarations` is NOT the removed bindings' names — it is, for each import
 * this pass deleted (whole or partial), a STANDALONE declaration text that
 * parses as exactly one `ImportDeclaration` and can be spliced back in as its
 * own line: the verbatim original text for a whole-declaration removal (so
 * restoring it after the file's last import reproduces the byte-for-byte
 * original when it already was the last one), or a synthesized `import { … }
 * from '…'` for a partial one (the survivors stay on their own line; the
 * restored bindings get a second line rather than being spliced back into a
 * declaration this pass no longer has to hand). Same order as `removed`.
 */
export interface PrunedImportsResult {
  /** Every binding name removed, in source order. */
  removed: readonly string[]
  /** One standalone, re-insertable declaration text per import removed, in source order. */
  declarations: readonly string[]
}

export interface ImportPruneSession {
  /** The import bindings `file` currently REFERENCES — take this BEFORE any edit lands. */
  snapshot(file: string): ReadonlySet<string>
  /** Remove every binding in `wasReferenced` that no longer has a reference. */
  prune(file: string, wasReferenced: ReadonlySet<string>): PrunedImportsResult
}

/**
 * The two calls a save batch makes, sharing one ts-morph `Project` so the
 * before/after pair costs one parse per file rather than two.
 *
 * A session rather than an optional `project` parameter on each function: the
 * caller is an HTTP handler that deliberately holds no ts-morph types, and a
 * module-level cache shared across requests would be worse than either.
 */
export function createImportPruneSession(): ImportPruneSession {
  const project = createProject()
  return {
    snapshot: (file) => referencedImportBindings(file, project),
    prune: (file, wasReferenced) => pruneOrphanedImports(file, wasReferenced, project),
  }
}

/**
 * The import bindings this file currently REFERENCES — the "before" snapshot.
 *
 * Returns an empty set for a file that does not exist or cannot be parsed:
 * with nothing recorded as live, the prune below can find nothing to remove,
 * which is the correct failure direction.
 */
function referencedImportBindings(file: string, project: ReturnType<typeof createProject>): ReadonlySet<string> {
  try {
    return referencedBindings(loadSourceFile(project, file))
  } catch (err) {
    console.error('[ast-codemods/pruneOrphanedImports] could not read import references:', err)
    return new Set()
  }
}

const NOTHING_PRUNED: PrunedImportsResult = { removed: [], declarations: [] }

/**
 * Remove every import binding that was in `wasReferenced` and no longer has a
 * reference in the file. Returns the removed names AND a re-insertable
 * declaration text per import removed, both in source order.
 *
 * Never throws: a file that vanished or stopped parsing mid-batch prunes
 * nothing rather than taking the whole save down.
 */
function pruneOrphanedImports(
  file: string,
  wasReferenced: ReadonlySet<string>,
  project: ReturnType<typeof createProject>,
): PrunedImportsResult {
  if (wasReferenced.size === 0) return NOTHING_PRUNED
  try {
    const sourceFile = loadSourceFile(project, file)
    const verbatim = verbatimSourceText(sourceFile, file)
    if (verbatim === null) return NOTHING_PRUNED

    const live = referencedBindings(sourceFile)
    const edits: TextEdit[] = []
    const removed: string[] = []
    const declarations: string[] = []

    for (const declaration of sourceFile.getImportDeclarations()) {
      const all = declarationBindings(declaration)
      const dead = all.filter((name) => wasReferenced.has(name) && !live.has(name))
      if (dead.length === 0) continue
      const wholeDeclaration = dead.length === all.length
      removed.push(...dead)
      declarations.push(reinsertableDeclarationText(declaration, dead, wholeDeclaration))
      edits.push(...removalEdits(verbatim, declaration, dead, wholeDeclaration))
    }

    if (edits.length === 0) return NOTHING_PRUNED
    writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, edits))
    return { removed, declarations }
  } catch (err) {
    console.error('[ast-codemods/pruneOrphanedImports] could not prune:', err)
    return NOTHING_PRUNED
  }
}

/**
 * The standalone declaration text that puts `dead` back — see
 * `PrunedImportsResult.declarations` for what this owes a caller and why a
 * partial removal is synthesized rather than sliced.
 *
 * A whole-declaration removal returns the declaration's own text verbatim
 * (comments aside — `getText()`'s ordinary trivia rule), never
 * `removalEdits`' owned RANGE: that range's job is knowing which BYTES to cut
 * (indentation, trailing newline included), not what a caller should splice
 * back in as a fresh, independent line.
 */
function reinsertableDeclarationText(declaration: ImportLike, dead: readonly string[], wholeDeclaration: boolean): string {
  if (wholeDeclaration) return declaration.getText()

  const removed = new Set(dead)
  const typePrefix = declaration.isTypeOnly() ? 'type ' : ''
  const moduleSpecifier = declaration.getModuleSpecifier().getText()
  const defaultImport = declaration.getDefaultImport()
  const namespaceImport = declaration.getNamespaceImport()
  const namedSpecifiers = declaration.getNamedImports().filter((s) => removed.has((s.getAliasNode() ?? s.getNameNode()).getText()))

  const clause: string[] = []
  if (defaultImport && removed.has(defaultImport.getText())) clause.push(defaultImport.getText())
  if (namespaceImport && removed.has(namespaceImport.getText())) clause.push(`* as ${namespaceImport.getText()}`)
  if (namedSpecifiers.length > 0) clause.push(`{ ${namedSpecifiers.map((s) => s.getText()).join(', ')} }`)

  return `import ${typePrefix}${clause.join(', ')} from ${moduleSpecifier}`
}

/** Every import binding with at least one identifier reference outside an import declaration. */
function referencedBindings(sourceFile: SourceFile): Set<string> {
  const imported = new Set<string>()
  for (const declaration of sourceFile.getImportDeclarations()) {
    for (const name of declarationBindings(declaration)) imported.add(name)
  }
  const referenced = new Set<string>()
  if (imported.size === 0) return referenced

  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = identifier.getText()
    if (!imported.has(name)) continue
    if (identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue
    referenced.add(name)
  }
  return referenced
}

/** Every binding name an import declaration introduces, in source order. */
function declarationBindings(declaration: ImportLike): string[] {
  const names: string[] = []
  const defaultImport = declaration.getDefaultImport()
  if (defaultImport) names.push(defaultImport.getText())
  const namespaceImport = declaration.getNamespaceImport()
  if (namespaceImport) names.push(namespaceImport.getText())
  for (const named of declaration.getNamedImports()) {
    names.push((named.getAliasNode() ?? named.getNameNode()).getText())
  }
  return names
}

type ImportLike = ReturnType<SourceFile['getImportDeclarations']>[number]

/**
 * The byte ranges to cut for one declaration.
 *
 * Whole-declaration removal takes the line, the way every other structural
 * removal here does. A PARTIAL removal is fiddlier only because of commas: a
 * separator belongs to the list, not to any one specifier, so the cut is
 * computed per contiguous RUN of dead specifiers — extending forward to the
 * next survivor, or (for a run reaching the end of the list) backward from the
 * previous one. A partial removal leaves at least one survivor, so exactly one
 * of those two always applies.
 */
function removalEdits(
  text: string,
  declaration: ImportLike,
  dead: readonly string[],
  wholeDeclaration: boolean,
): TextEdit[] {
  if (wholeDeclaration) {
    const owned = ownedTextRange(text, declaration.getStart(), declaration.getEnd())
    return [{ start: owned.start, end: owned.end, text: '' }]
  }

  const removed = new Set(dead)
  const edits: TextEdit[] = []
  const clauseBindings = declaration.getImportClause()?.getNamedBindings()
  const defaultImport = declaration.getDefaultImport()

  // A default binding dropped while its named siblings survive: cut from its
  // own start up to the surviving `{`, which takes the comma with it.
  if (defaultImport && removed.has(defaultImport.getText()) && clauseBindings) {
    edits.push({ start: defaultImport.getStart(), end: clauseBindings.getStart(), text: '' })
  }
  // A namespace binding dropped after a surviving default: `, * as N` goes.
  const namespaceImport = declaration.getNamespaceImport()
  if (namespaceImport && removed.has(namespaceImport.getText()) && defaultImport) {
    edits.push({ start: defaultImport.getEnd(), end: namespaceImport.getEnd(), text: '' })
  }

  const specifiers = declaration.getNamedImports()
  const isDead = specifiers.map((s) => removed.has((s.getAliasNode() ?? s.getNameNode()).getText()))

  // Every named specifier dropped while a default survives: the whole `, { … }`.
  if (specifiers.length > 0 && isDead.every(Boolean)) {
    if (defaultImport && clauseBindings) {
      edits.push({ start: defaultImport.getEnd(), end: clauseBindings.getEnd(), text: '' })
    }
    return edits
  }

  for (let i = 0; i < specifiers.length; i += 1) {
    if (!isDead[i]) continue
    let runEnd = i
    while (runEnd + 1 < specifiers.length && isDead[runEnd + 1]) runEnd += 1

    const next = specifiers[runEnd + 1]
    if (next) edits.push({ start: specifiers[i]!.getStart(), end: next.getStart(), text: '' })
    else edits.push({ start: specifiers[i - 1]!.getEnd(), end: specifiers[runEnd]!.getEnd(), text: '' })

    i = runEnd
  }

  return edits
}
