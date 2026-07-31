/**
 * deleteJsxElement — `struct-01`, the write behind "delete this element" on
 * the board. Removes the JSX child element at a `line:col`, along with the
 * indentation and newline it owned, and writes the file back.
 *
 * FAILS CLOSED, and says why. Two refusals are its own, and both are about
 * leaving the user's repository in a state their toolchain accepts:
 *
 *  - **`no-jsx-parent`** (from `resolveJsxChildRange`) — the element is the
 *    outermost thing the component returns. Deleting it leaves `return ;`, a
 *    file that no longer parses.
 *  - **`orphans-import`** — every remaining reference to some imported binding
 *    lived inside the deleted subtree (`<Card/>` was the only `Card`,
 *    `src={hero}` the only `hero`). Removing the element without removing the
 *    import leaves an unused import, which under `noUnusedLocals` is a build
 *    failure in the user's own project; removing the import as well would make
 *    this edit touch a second, unrelated place in the file. Neither is one
 *    honest target, so it refuses and names the binding.
 *
 * Deliberately does NOT tidy up after itself. A codemod that "helpfully"
 * deletes an import, collapses a now-empty parent, or reformats the gap it
 * left is a codemod that changes bytes the user never pointed at. What is left
 * behind is exactly the file minus one element.
 */
import { Project, SyntaxKind, type SourceFile } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
} from './jsxChildRange'

export interface DeleteJsxElementParams {
  file: string
  /** 1-based line/col of the element being deleted (its tag-name start). */
  line: number
  col: number
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type DeleteJsxRefusalReason = JsxChildRangeReason | 'orphans-import'

export interface DeleteJsxRefusal {
  reason: DeleteJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type DeleteJsxElementResult = { ok: true } | { ok: false; refusal: DeleteJsxRefusal }

export function deleteJsxElement(params: DeleteJsxElementParams): DeleteJsxElementResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const target = resolveJsxChildRange(sourceFile, line, col)
  if (!target.ok) return { ok: false, refusal: { reason: target.reason, message: target.message } }

  const orphaned = importOrphanedByRemoval(sourceFile, target.range.start, target.range.end)
  if (orphaned) {
    return {
      ok: false,
      refusal: {
        reason: 'orphans-import',
        message: `Deleting this would leave the "${orphaned}" import unused, which breaks the project's own build. Remove the element and its import together in the file.`,
      },
    }
  }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return {
      ok: false,
      refusal: {
        reason: 'stale-source',
        message: 'This file changed on disk since the canvas last read it. Reload the project and try again.',
      },
    }
  }

  writeVerbatimSource(sourceFile, file, verbatim.slice(0, target.range.start) + verbatim.slice(target.range.end))
  return { ok: true }
}

/**
 * The name of an imported binding whose every use sits inside `[start, end)`,
 * or `undefined` when removing that range orphans nothing.
 *
 * Counts identifier references outside import declarations only — the import
 * clause names the binding, it does not use it — and requires at least one use
 * INSIDE the range, so an import that was already unused before this edit is
 * not blamed on it.
 */
function importOrphanedByRemoval(sourceFile: SourceFile, start: number, end: number): string | undefined {
  const imported = new Set<string>()
  for (const declaration of sourceFile.getImportDeclarations()) {
    const defaultImport = declaration.getDefaultImport()
    if (defaultImport) imported.add(defaultImport.getText())
    const namespaceImport = declaration.getNamespaceImport()
    if (namespaceImport) imported.add(namespaceImport.getText())
    for (const named of declaration.getNamedImports()) {
      imported.add((named.getAliasNode() ?? named.getNameNode()).getText())
    }
  }
  if (imported.size === 0) return undefined

  const inside = new Set<string>()
  const outside = new Set<string>()
  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = identifier.getText()
    if (!imported.has(name)) continue
    if (identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue
    const at = identifier.getStart()
    if (at >= start && at < end) inside.add(name)
    else outside.add(name)
  }
  for (const name of inside) {
    if (!outside.has(name)) return name
  }
  return undefined
}
