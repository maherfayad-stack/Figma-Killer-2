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
 * The two calls a save batch makes, sharing one ts-morph `Project` so the
 * before/after pair costs one parse per file rather than two.
 *
 * A session rather than an optional `project` parameter on each function: the
 * caller is an HTTP handler that deliberately holds no ts-morph types, and a
 * module-level cache shared across requests would be worse than either.
 */
export interface ImportPruneSession {
  /** The import bindings `file` currently REFERENCES — take this BEFORE any edit lands. */
  snapshot(file: string): ReadonlySet<string>
  /** Remove every binding in `wasReferenced` that no longer has a reference. Returns the removed names. */
  prune(file: string, wasReferenced: ReadonlySet<string>): readonly string[]
}

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

/**
 * Remove every import binding that was in `wasReferenced` and no longer has a
 * reference in the file. Returns the removed names, in source order.
 *
 * Never throws: a file that vanished or stopped parsing mid-batch prunes
 * nothing rather than taking the whole save down.
 */
function pruneOrphanedImports(
  file: string,
  wasReferenced: ReadonlySet<string>,
  project: ReturnType<typeof createProject>,
): readonly string[] {
  if (wasReferenced.size === 0) return []
  try {
    const sourceFile = loadSourceFile(project, file)
    const verbatim = verbatimSourceText(sourceFile, file)
    if (verbatim === null) return []

    const live = referencedBindings(sourceFile)
    const edits: TextEdit[] = []
    const removed: string[] = []

    for (const declaration of sourceFile.getImportDeclarations()) {
      const all = declarationBindings(declaration)
      const dead = all.filter((name) => wasReferenced.has(name) && !live.has(name))
      if (dead.length === 0) continue
      removed.push(...dead)
      edits.push(...removalEdits(verbatim, declaration, dead, dead.length === all.length))
    }

    if (edits.length === 0) return []
    writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, edits))
    return removed
  } catch (err) {
    console.error('[ast-codemods/pruneOrphanedImports] could not prune:', err)
    return []
  }
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
