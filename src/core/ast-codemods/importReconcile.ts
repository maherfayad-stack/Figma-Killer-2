/**
 * importReconcile — shared import-mirroring machinery for every codemod that
 * moves JSX between files.
 *
 * Three codemods ask the identical question, just with the two files swapped:
 * "this JSX subtree references NAME, which is declared/imported in FILE A —
 * how does FILE B get the same binding?"
 *
 *   - `detachComponent.ts` inlines a component's JSX AT its call site: FILE A
 *     is the component's own file, FILE B is the page.
 *   - `extractSubtreeToComponent.ts` does the reverse — pulls a page subtree
 *     OUT into a new component file: FILE A is the page, FILE B is the new
 *     component file.
 *   - `swapComponentInstance.ts` repoints one call site at a different
 *     component and needs the same "is this name already unused, drop its
 *     import" half of the question.
 *
 * Extracted rather than left triplicated per-codemod — CLAUDE.md forbids
 * old-and-new side by side, and this was heading toward a third copy
 * (`swapComponentInstance.ts` already carried its own near-identical
 * `topLevelBindingNames`/`relativeSpecifier`/`removeImportIfUnused` with a
 * comment admitting the duplication was "kept local"). One implementation,
 * three callers.
 */
import * as path from 'node:path'
import { Node, type ImportDeclaration, type SourceFile } from 'ts-morph'

/** A relative module specifier from `fromFileAbs`'s directory to `toFileAbs`, POSIX-separated, extension stripped. */
export function relativeSpecifier(fromFileAbs: string, toFileAbs: string): string {
  const fromDir = path.dirname(fromFileAbs)
  let rel = path.relative(fromDir, toFileAbs).split(path.sep).join('/')
  rel = rel.replace(/\.(tsx|jsx|ts|js)$/, '')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel
}

/** Every name bound at `sourceFile`'s own top level — import bindings, and top-level function/class/variable declarations. The scope a mirrored import must not collide with, and the scope a name-collision check reads. */
export function topLevelBindingNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>()
  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getDefaultImport()) names.add(decl.getDefaultImport()!.getText())
    if (decl.getNamespaceImport()) names.add(decl.getNamespaceImport()!.getText())
    for (const named of decl.getNamedImports()) {
      names.add(named.getAliasNode()?.getText() ?? named.getNameNode().getText())
    }
  }
  for (const fn of sourceFile.getFunctions()) if (fn.getName()) names.add(fn.getName()!)
  for (const cls of sourceFile.getClasses()) if (cls.getName()) names.add(cls.getName()!)
  for (const v of sourceFile.getVariableDeclarations()) names.add(v.getName())
  return names
}

function mirrorImport(destinationFile: SourceFile, originFile: SourceFile, originImport: ImportDeclaration, name: string): void {
  const specifierText = originImport.getModuleSpecifierValue()
  const isRelative = specifierText.startsWith('.')
  const specifier = isRelative
    ? relativeSpecifier(destinationFile.getFilePath(), path.resolve(path.dirname(originFile.getFilePath()), specifierText))
    : specifierText
  const isDefault = originImport.getDefaultImport()?.getText() === name
  const isNamespace = originImport.getNamespaceImport()?.getText() === name
  destinationFile.addImportDeclaration({
    moduleSpecifier: specifier,
    ...(isDefault ? { defaultImport: name } : {}),
    ...(isNamespace ? { namespaceImport: name } : {}),
    ...(!isDefault && !isNamespace ? { namedImports: [name] } : {}),
  })
}

/**
 * Adds imports to `destinationFile` so identifiers that `originFile`'s own
 * moved JSX (or expressions) references can still resolve once that content
 * lands in `destinationFile`: for every name in `identifiers` that
 * `originFile` itself imports, mirrors an equivalent import in
 * `destinationFile` — following the import to whatever file/specifier it
 * actually names, resolving a relative specifier fresh against
 * `destinationFile`'s own location; for a name `originFile` declares directly
 * at its own top level (a same-file helper/const), imports it FROM
 * `originFile` itself. A name already bound at `destinationFile`'s own top
 * level is left alone — trusted as-is (a real collision against a DIFFERENT
 * source is rare enough that resolving it precisely would need chasing the
 * existing binding's own declaration file too; left as a documented gap
 * rather than a guess, same posture `detachComponent.ts` stated originally).
 */
export function addReconciledImports(
  destinationFile: SourceFile,
  originFile: SourceFile,
  identifiers: ReadonlySet<string>,
): void {
  const destinationTopLevelNames = topLevelBindingNames(destinationFile)

  for (const name of identifiers) {
    if (destinationTopLevelNames.has(name)) continue

    const originImport = originFile.getImportDeclarations().find((decl) => {
      if (decl.getDefaultImport()?.getText() === name) return true
      if (decl.getNamespaceImport()?.getText() === name) return true
      return decl.getNamedImports().some((n) => (n.getAliasNode()?.getText() ?? n.getNameNode().getText()) === name)
    })

    if (originImport) {
      mirrorImport(destinationFile, originFile, originImport, name)
      continue
    }

    const declaredInOrigin =
      originFile.getFunction(name) !== undefined ||
      originFile.getVariableDeclaration(name) !== undefined ||
      originFile.getClass(name) !== undefined
    if (declaredInOrigin) {
      const specifier = relativeSpecifier(destinationFile.getFilePath(), originFile.getFilePath())
      destinationFile.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [name] })
      continue
    }
    // Otherwise: a global (`Math`, `String`, …) or something this module
    // can't trace — left unimported; TypeScript/the bundler will surface it
    // loudly rather than this codemod guessing.
  }
}

/** Removes `localName`'s import from `sourceFile` if no JSX tag or plain identifier reference to it remains anywhere in the file. */
export function removeImportIfLastUsage(sourceFile: SourceFile, localName: string): void {
  const stillUsed = sourceFile.getDescendants().some((node) => {
    if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node) || Node.isJsxClosingElement(node)) {
      return node.getTagNameNode().getText().split('.')[0] === localName
    }
    if (Node.isIdentifier(node) && node.getText() === localName) {
      const parent = node.getParent()
      // Exclude the identifier's own declaration site (an import specifier),
      // which always "matches" trivially.
      return !(Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent))
    }
    return false
  })
  if (stillUsed) return

  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() === localName) {
      if (decl.getNamedImports().length === 0 && !decl.getNamespaceImport()) decl.remove()
      else decl.getDefaultImport()!.replaceWithText('') // rare mixed-import shape — leave named imports intact
      return
    }
    if (decl.getNamespaceImport()?.getText() === localName) {
      decl.remove()
      return
    }
    const named = decl.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getNameNode().getText()) === localName)
    if (named) {
      if (decl.getNamedImports().length === 1 && !decl.getDefaultImport() && !decl.getNamespaceImport()) decl.remove()
      else named.remove()
      return
    }
  }
}
