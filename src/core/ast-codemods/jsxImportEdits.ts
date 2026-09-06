/**
 * jsxImportEdits — the import half of writing a component into someone's file.
 *
 * Split out of `insertJsxElement.ts` (W4-1) once a second codemod needed it:
 * `wrapJsxElement` can wrap a subtree in a design-system component, and a
 * `<Card>` with no `Card` in scope is not valid code. Adding an element and its
 * import is one indivisible statement written in two places, so the two edits
 * are computed together and spliced in the same pass — never leaving the file
 * in the half-written state.
 */
import type { Node, SourceFile } from 'ts-morph'
import type { TextEdit } from './jsxChildRange'

/**
 * The edits that put every `(name → specifier)` in `required` in scope.
 *
 * Per specifier, three cases, cheapest first: the import declaration exists and
 * already names the binding (nothing to do); it exists and gains one more named
 * import; it does not exist and a whole line is added after the last import.
 * The quote character is copied from an existing import so a file written with
 * double quotes does not acquire a single-quoted line.
 *
 * Every returned edit is measured against the ORIGINAL text and the caller
 * applies them in descending-offset order. That is why all the brand-new
 * declarations are emitted as ONE edit at a single offset rather than one edit
 * each: several edits sharing an identical `start` would be applied in an
 * unspecified relative order, and — being zero-length inserts at the same point
 * — could interleave. Grouping them keeps the written order deterministic
 * (specifier insertion order, which is the subtree's own depth-first order).
 */
export function resolveImportEdits(
  sourceFile: SourceFile,
  text: string,
  required: ReadonlyMap<string, string>,
): TextEdit[] {
  if (required.size === 0) return []

  const declarations = sourceFile.getImportDeclarations()
  const quote = importQuoteChar(declarations)
  const edits: TextEdit[] = []
  /** Specifier → the names it must newly declare, in first-seen order. */
  const newDeclarations = new Map<string, string[]>()

  for (const [name, specifier] of required) {
    const existing = declarations.find((d) => d.getModuleSpecifierValue() === specifier)
    if (existing) {
      const named = existing.getNamedImports()
      if (named.some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name)) continue
      const lastNamed = named[named.length - 1]
      if (lastNamed) {
        const at = lastNamed.getEnd()
        edits.push({ start: at, end: at, text: `, ${name}` })
        continue
      }
      // A default- or namespace-only import: `import DS from 'x'` gains `, { name }`.
      const defaultImport = existing.getDefaultImport() ?? existing.getNamespaceImport()
      if (defaultImport) {
        const at = defaultImport.getEnd()
        edits.push({ start: at, end: at, text: `, { ${name} }` })
        continue
      }
      // A bare side-effect import (`import 'x'`) — leave it alone and add a
      // second, explicit declaration below rather than rewriting the user's line.
    }
    const names = newDeclarations.get(specifier)
    if (names) names.push(name)
    else newDeclarations.set(specifier, [name])
  }

  if (newDeclarations.size > 0) {
    const lines = [...newDeclarations]
      .map(([specifier, names]) => `import { ${names.join(', ')} } from ${quote}${specifier}${quote}\n`)
      .join('')
    const lastDeclaration = declarations[declarations.length - 1]
    if (!lastDeclaration) {
      edits.push({ start: 0, end: 0, text: lines })
    } else {
      // Start of the line after the last import, so the new lines join the block.
      const newlineAfter = text.indexOf('\n', lastDeclaration.getEnd())
      const at = newlineAfter === -1 ? text.length : newlineAfter + 1
      edits.push({ start: at, end: at, text: lines })
    }
  }

  return edits
}

/** The quote character the file's existing imports use — `'` when there are none to copy. */
function importQuoteChar(declarations: readonly { getModuleSpecifier: () => Node }[]): string {
  const first = declarations[0]
  if (!first) return "'"
  return first.getModuleSpecifier().getText().startsWith('"') ? '"' : "'"
}

/**
 * How `name` is already bound in this file, when that binding is NOT the
 * import a write wants — a local `function Button()`, a `const Button =`, or an
 * import of the same name from a different module. `undefined` when the name is
 * free, or already bound to exactly the right import.
 *
 * Reads declarations only, never references: the question is what the name
 * MEANS in this file, and a shadowing write is the one outcome that would
 * silently change an element the user never touched.
 */
export function conflictingBinding(sourceFile: SourceFile, name: string, specifier: string): string | undefined {
  for (const declaration of sourceFile.getImportDeclarations()) {
    const from = declaration.getModuleSpecifierValue()
    const names = [
      declaration.getDefaultImport()?.getText(),
      declaration.getNamespaceImport()?.getText(),
      ...declaration.getNamedImports().map((n) => (n.getAliasNode() ?? n.getNameNode()).getText()),
    ]
    if (!names.includes(name)) continue
    if (from === specifier) return undefined
    return `it is imported from "${from}"`
  }
  for (const fn of sourceFile.getFunctions()) {
    if (fn.getName() === name) return 'a function declared here'
  }
  for (const statement of sourceFile.getVariableDeclarations()) {
    if (statement.getName() === name) return 'a variable declared here'
  }
  for (const cls of sourceFile.getClasses()) {
    if (cls.getName() === name) return 'a class declared here'
  }
  return undefined
}
