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
import { SyntaxKind, type Node, type SourceFile } from 'ts-morph'
import type { TextEdit } from './jsxChildRange'

/**
 * How a binding is written on its import declaration.
 *
 * `named` is what Studio writes for a component it authors, and was the only
 * shape this module could express until D2 G3's cross-file move
 * (`transplantJsxElement.ts`) needed to MIRROR a binding the user already
 * wrote: dragging `<Logo/>` from one page to another has to carry whatever
 * `import Logo from './Logo'` said, and re-spelling a default import as a
 * named one writes a line that does not compile.
 */
export type ImportBindingStyle = 'named' | 'default' | 'namespace'

/** One binding a write needs in scope: where it comes from, and how it is written. */
export interface ImportRequirement {
  specifier: string
  /** Omitted means `named` — the shape Studio writes for a component it authors itself. */
  style?: ImportBindingStyle
  /**
   * P3-C (WB-19) — the EXPORTED name, when the local binding (the map key) is
   * an alias of it: `{ Button as Button2 }`. Omitted when the two are the
   * same. Only a `named` binding spells it — a default or namespace import
   * already takes any local name.
   */
  imported?: string
}

/**
 * The edits that put every `(name → requirement)` in `required` in scope.
 *
 * Per specifier, three cases, cheapest first: the import declaration exists and
 * already names the binding (nothing to do); it exists and gains one more named
 * import; it does not exist and a whole line is added after the last import.
 * The quote character is copied from an existing import so a file written with
 * double quotes does not acquire a single-quoted line.
 *
 * A `default`/`namespace` requirement never joins an existing declaration's
 * named list — the two are different positions on the line, and a file that
 * already imports something else from that specifier may well already have a
 * default of its own. It gets a declaration of its own instead, which is
 * always valid even when it means two `import … from 'x'` lines.
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
  required: ReadonlyMap<string, ImportRequirement>,
): TextEdit[] {
  if (required.size === 0) return []

  const declarations = sourceFile.getImportDeclarations()
  const quote = importQuoteChar(declarations)
  const edits: TextEdit[] = []
  /** The whole declaration lines this write adds, in first-seen order. */
  const newLines: string[] = []
  /** Specifier → the NAMED bindings it must newly declare, in first-seen order. */
  const newNamed = new Map<string, string[]>()

  for (const [name, requirement] of required) {
    const { specifier } = requirement
    const style = requirement.style ?? 'named'
    const existing = declarations.find((d) => d.getModuleSpecifierValue() === specifier)

    if (style !== 'named') {
      if (existing) {
        const alreadyThere =
          style === 'default'
            ? existing.getDefaultImport()?.getText() === name
            : existing.getNamespaceImport()?.getText() === name
        if (alreadyThere) continue
      }
      newLines.push(
        style === 'default'
          ? `import ${name} from ${quote}${specifier}${quote}\n`
          : `import * as ${name} from ${quote}${specifier}${quote}\n`,
      )
      continue
    }

    const imported = requirement.imported ?? name
    const spelled = imported === name ? name : `${imported} as ${name}`
    if (existing) {
      const named = existing.getNamedImports()
      if (named.some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name && n.getNameNode().getText() === imported)) {
        continue
      }
      const lastNamed = named[named.length - 1]
      if (lastNamed) {
        const at = lastNamed.getEnd()
        edits.push({ start: at, end: at, text: `, ${spelled}` })
        continue
      }
      // A default- or namespace-only import: `import DS from 'x'` gains `, { name }`.
      const defaultImport = existing.getDefaultImport() ?? existing.getNamespaceImport()
      if (defaultImport) {
        const at = defaultImport.getEnd()
        edits.push({ start: at, end: at, text: `, { ${spelled} }` })
        continue
      }
      // A bare side-effect import (`import 'x'`) — leave it alone and add a
      // second, explicit declaration below rather than rewriting the user's line.
    }
    const names = newNamed.get(specifier)
    if (names) names.push(spelled)
    else newNamed.set(specifier, [spelled])
  }

  for (const [specifier, names] of newNamed) {
    newLines.push(`import { ${names.join(', ')} } from ${quote}${specifier}${quote}\n`)
  }

  if (newLines.length > 0) {
    const lines = newLines.join('')
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

/**
 * P3-C (WB-19) — the local name each component a write needs is bound to in
 * THIS file, choosing an alias instead of refusing when the plain name is
 * taken.
 *
 * `binding-conflict` used to refuse an insert, a wrap or a slot fill whenever
 * the file already used the component's name for something else ("Rename one
 * of them in the file first"). The name is only a spelling: importing
 * `{ Button as Button2 }` and writing `<Button2 />` renders the same component
 * and touches nothing the user wrote — one honest target. Per component,
 * cheapest first:
 *
 *   1. the file already imports this export from this module, under any local
 *      name (`import { Button as DSButton }`) — reuse it, add nothing;
 *   2. the plain name is free — use it;
 *   3. otherwise the first free `<Name>2`, `<Name>3`, … — free meaning no
 *      identifier ANYWHERE in the file (a local `Button2` inside the component
 *      would shadow a top-level import) and no other alias this write chose.
 *
 * Returns the requirements keyed by LOCAL name (what `resolveImportEdits`
 * writes, `imported` naming the export when the two differ) and the rename
 * every component tag in the written markup must go through.
 */
export interface PlannedImportBindings {
  required: Map<string, ImportRequirement>
  localName: (name: string) => string
}

export function planImportBindings(
  sourceFile: SourceFile,
  required: ReadonlyMap<string, ImportRequirement>,
): PlannedImportBindings {
  const planned = new Map<string, ImportRequirement>()
  const renames = new Map<string, string>()
  let used: Set<string> | undefined
  for (const [name, requirement] of required) {
    const existing = existingLocalFor(sourceFile, name, requirement)
    if (existing !== undefined || !conflictingBinding(sourceFile, name, requirement.specifier)) {
      const local = existing ?? name
      if (local !== name) renames.set(name, local)
      planned.set(local, local === name ? requirement : { ...requirement, imported: name })
      continue
    }
    used ??= new Set(sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).map((identifier) => identifier.getText()))
    const local = freeAlias(name, used, planned)
    renames.set(name, local)
    planned.set(local, { ...requirement, imported: name })
  }
  return { required: planned, localName: (name) => renames.get(name) ?? name }
}

/** The local name an existing import of the same module already gives this export (`{ Button as DSButton }`, or its default). */
function existingLocalFor(sourceFile: SourceFile, name: string, requirement: ImportRequirement): string | undefined {
  const style = requirement.style ?? 'named'
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== requirement.specifier) continue
    if (style === 'named') {
      const named = declaration.getNamedImports().find((n) => n.getNameNode().getText() === (requirement.imported ?? name))
      if (named) return (named.getAliasNode() ?? named.getNameNode()).getText()
      continue
    }
    const local = style === 'default' ? declaration.getDefaultImport() : declaration.getNamespaceImport()
    if (local) return local.getText()
  }
  return undefined
}

function freeAlias(name: string, used: ReadonlySet<string>, planned: ReadonlyMap<string, ImportRequirement>): string {
  for (let n = 2; ; n += 1) {
    const candidate = `${name}${n}`
    if (!used.has(candidate) && !planned.has(candidate)) return candidate
  }
}
