/**
 * componentCallSites — E2.2's "state the blast radius up front" requirement
 * for `addSlotPropToComponent.ts`: every JSX tag in the workspace that
 * actually renders a given (file, exportName) component.
 *
 * This is `componentSources.ts`'s own question asked in REVERSE. That module
 * answers "what does THIS call site's identifier resolve to" (barrel-aware,
 * via `resolveExportedDeclaration`) for one page at a time; this module asks
 * "who, anywhere in the workspace, resolves to THIS declaration" — the same
 * resolution primitive, run against every file instead of one. Local
 * components only: a package-published component has no `.tsx` file in this
 * workspace to add a slot prop to in the first place, so there is nothing to
 * scan a call site's OWN import against beyond "is it even relative".
 */
import * as path from 'node:path'
import { SyntaxKind, type Project, type SourceFile } from 'ts-morph'
import { resolveExportedDeclaration } from '@core/page-parser'

export interface ComponentCallSite {
  /** Workspace-relative POSIX path of the file holding this call site. */
  file: string
  /** 1-based line/col of the call site's own tag-name start — this module's usual location convention. */
  line: number
  col: number
  /** The JSX tag's own local identifier text at this call site (after any `import { X as Y }` alias) — lets a blast-radius list distinguish two differently-aliased call sites. */
  localName: string
}

/**
 * True when `target` — the file `importedName` is imported FROM, whatever
 * the importing file's own specifier names (could be `componentFileAbs`
 * itself, or a barrel that re-exports it) — resolves to `componentFileAbs`'s
 * own export named `exportName`. `importedName` is `'default'` for a default
 * import.
 */
function importResolvesToComponent(
  target: SourceFile | undefined,
  importedName: string,
  componentFileAbs: string,
  exportName: string,
): boolean {
  if (!target) return false
  if (path.resolve(target.getFilePath()) === componentFileAbs) {
    // A DIRECT import — no barrel in between. Comparing the file alone is
    // enough, and this deliberately does NOT fall through to
    // `resolveExportedDeclaration` below: that helper requires the exported
    // declaration to be NAMEABLE (`Node.hasName`), which fails for a common,
    // real shape — `export default function () {...}` — that a direct
    // import must still recognize.
    return importedName === exportName
  }
  // Indirect — walk through the barrel to see where `importedName` actually
  // resolves, and under what name.
  const resolved = resolveExportedDeclaration(target, importedName)
  return resolved !== undefined && path.resolve(resolved.sourceFile.getFilePath()) === componentFileAbs && resolved.name === exportName
}

/**
 * Every local identifier `sourceFile` binds (via `import`) that resolves to
 * `(componentFileAbs, exportName)` — default and named imports only. A
 * namespace import (`import * as X from './Card'`, used as `<X.Card/>`) is
 * NOT resolved here: correctly matching it would need to know which of `X`'s
 * members is being referenced at each individual call site, a materially
 * different (and much rarer, for a single-component file) question than the
 * default/named case this module answers. Documented gap, not a silent one.
 */
function localNamesFor(sourceFile: SourceFile, componentFileAbs: string, exportName: string): Set<string> {
  const names = new Set<string>()
  for (const decl of sourceFile.getImportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile()

    const defaultImport = decl.getDefaultImport()
    if (defaultImport && importResolvesToComponent(target, 'default', componentFileAbs, exportName)) {
      names.add(defaultImport.getText())
    }

    for (const named of decl.getNamedImports()) {
      const importedName = named.getNameNode().getText()
      if (!importResolvesToComponent(target, importedName, componentFileAbs, exportName)) continue
      names.add(named.getAliasNode()?.getText() ?? importedName)
    }
  }
  return names
}

/**
 * Scans every file `project` already knows about for a JSX tag that renders
 * `(componentFile, exportName)` — the blast radius `addSlotPropToComponent`
 * must show BEFORE a caller commits. Call this FIRST, as the panel's own
 * preview step; `addSlotPropToComponent`'s own success result also carries
 * the identical list afterward, for a post-commit confirmation summary, not
 * as the first time the user sees it — see that module's own doc.
 *
 * Workspace-wide, uncached — the same accepted cost posture Track E1's
 * `extractLocalComponentCatalog` already established for a whole-project
 * ts-morph walk (see that module's handoff for measured numbers: a few
 * hundred milliseconds, fixed cost dominated by the Project's own first
 * binder pass, on a few-hundred-file workspace).
 */
export function findComponentCallSites(
  project: Project,
  workspaceRoot: string,
  componentFile: string,
  exportName: string,
): ComponentCallSite[] {
  const componentFileAbs = path.resolve(componentFile)
  const results: ComponentCallSite[] = []

  for (const sourceFile of project.getSourceFiles()) {
    const localNames = localNamesFor(sourceFile, componentFileAbs, exportName)
    if (localNames.size === 0) continue

    const relFile = path.relative(workspaceRoot, sourceFile.getFilePath()).split(path.sep).join('/')
    const openings = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ]
    for (const opening of openings) {
      const tagNameNode = opening.getTagNameNode()
      const root = tagNameNode.getText().split('.')[0]!
      if (!localNames.has(root)) continue
      const { line, column } = sourceFile.getLineAndColumnAtPos(tagNameNode.getStart())
      results.push({ file: relFile, line, col: column, localName: root })
    }
  }

  return results
}
