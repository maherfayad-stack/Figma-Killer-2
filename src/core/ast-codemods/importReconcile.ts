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
 * One implementation, three callers.
 *
 * IDENTITY, NOT SPELLING
 * ----------------------
 * Two imports are the same binding when they name the same MODULE and the
 * same EXPORT — never when they merely share a local name. `styles` from
 * `./Page.module.css` and `styles` from `../components/Card.module.css` are
 * two different bindings, and treating the second as "already imported"
 * silently restyled every detached element with the page's classes (the
 * audit's DET-1, bug 3). So a name that is taken by a DIFFERENT binding is
 * ALIASED (`import cardStyles from '…/Card.module.css'`), and the caller gets
 * the rename to apply to the text it is moving.
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

// ---------------------------------------------------------------------------
// Import identity
// ---------------------------------------------------------------------------

/** Which export an import binding names. `'default'` and `'*'` (a namespace import) are their own kinds; anything else is a named export. */
export type ImportedName = { kind: 'default' } | { kind: 'namespace' } | { kind: 'named'; name: string }

/**
 * One binding a destination file needs: which module, which export, and
 * whether it is type-only. `moduleKey` is the identity (see
 * {@link importModuleKey}); `target` is how to SPELL the module from any
 * destination file.
 */
export interface ImportRequest {
  moduleKey: string
  target: { kind: 'file'; absPath: string } | { kind: 'bare'; specifier: string }
  imported: ImportedName
  typeOnly: boolean
}

const toPosix = (p: string): string => p.split('\\').join('/')

/**
 * The identity of the module an import declaration names: the absolute path
 * of the source file it resolves to, or — for a module ts-morph cannot load
 * (a stylesheet, an image, a `?raw` asset) — the absolute path a relative
 * specifier points at, or a bare specifier verbatim. Two declarations with the
 * same key load the same module, however each file spells it.
 */
export function importModuleKey(decl: ImportDeclaration): string {
  const resolved = decl.getModuleSpecifierSourceFile()
  if (resolved) return toPosix(resolved.getFilePath())
  const specifier = decl.getModuleSpecifierValue()
  if (specifier.startsWith('.')) return toPosix(path.resolve(path.dirname(decl.getSourceFile().getFilePath()), specifier))
  return specifier
}

/** The request equivalent to one existing import binding of `decl` — the binding a name in `decl`'s file refers to. */
export function importRequestForBinding(decl: ImportDeclaration, imported: ImportedName, specifierTypeOnly = false): ImportRequest {
  const specifier = decl.getModuleSpecifierValue()
  return {
    moduleKey: importModuleKey(decl),
    target: specifier.startsWith('.')
      ? { kind: 'file', absPath: path.resolve(path.dirname(decl.getSourceFile().getFilePath()), specifier) }
      : { kind: 'bare', specifier },
    imported,
    typeOnly: decl.isTypeOnly() || specifierTypeOnly,
  }
}

/** The request for an export `exportName` of the source file `file` itself — a helper the origin DECLARES rather than imports. */
export function importRequestForExport(file: SourceFile, exportName: string): ImportRequest {
  return {
    moduleKey: toPosix(file.getFilePath()),
    target: { kind: 'file', absPath: file.getFilePath() },
    imported: exportName === 'default' ? { kind: 'default' } : { kind: 'named', name: exportName },
    typeOnly: false,
  }
}

function specifierFor(destination: SourceFile, request: ImportRequest): string {
  return request.target.kind === 'bare' ? request.target.specifier : relativeSpecifier(destination.getFilePath(), request.target.absPath)
}

/** The local name `decl` binds for `imported`, if it binds it at all (and not type-only when a value is needed). */
function localNameIn(decl: ImportDeclaration, request: ImportRequest): string | undefined {
  if (decl.isTypeOnly() && !request.typeOnly) return undefined
  const { imported } = request
  if (imported.kind === 'default') {
    const direct = decl.getDefaultImport()?.getText()
    if (direct) return direct
    const named = decl.getNamedImports().find((n) => n.getName() === 'default' && (request.typeOnly || !n.isTypeOnly()))
    return named ? (named.getAliasNode()?.getText() ?? named.getName()) : undefined
  }
  if (imported.kind === 'namespace') return decl.getNamespaceImport()?.getText()
  const named = decl.getNamedImports().find((n) => n.getName() === imported.name && (request.typeOnly || !n.isTypeOnly()))
  return named ? (named.getAliasNode()?.getText() ?? named.getName()) : undefined
}

// ---------------------------------------------------------------------------
// Plan, then apply
// ---------------------------------------------------------------------------

export interface ImportBindingOptions {
  /** The name the origin uses — the local name to prefer when it is free. */
  preferred: string
  /** Whether an EXISTING equivalent binding named `local` may be reused as-is (the caller knows whether something shadows it where the moved text lands). */
  isReusable(local: string): boolean
  /** Whether a NEW binding may take `local` without changing what any other reference in the destination means. */
  isAvailable(local: string): boolean
  /** A name to alias with when `preferred` is taken, derived from the origin (e.g. the component's name). */
  aliasPrefix: string
}

export interface PlannedImportBinding {
  local: string
  /** True when an equivalent binding already exists and nothing needs to be written. */
  existing: boolean
}

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/** `styles` + `Card` → `cardStyles`; `Icon` + `Card` → `CardIcon`, then numbered — a component stays capitalized, so it stays a component in JSX. */
function* aliasCandidates(prefix: string, name: string): Generator<string> {
  const base = /^[A-Z]/.test(name) ? `${upperFirst(prefix)}${name}` : `${lowerFirst(prefix)}${upperFirst(name)}`
  yield base
  for (let n = 2; ; n += 1) yield `${base}${n}`
}

/**
 * Decides, WITHOUT writing anything, which local name `destination` should
 * use for `request`: an equivalent binding it already has (same module, same
 * export), else `preferred` when it is free, else a fresh alias. Pure, so a
 * caller can plan every binding it needs and refuse before the first byte
 * changes.
 */
export function planImportBinding(destination: SourceFile, request: ImportRequest, options: ImportBindingOptions): PlannedImportBinding {
  for (const decl of destination.getImportDeclarations()) {
    if (importModuleKey(decl) !== request.moduleKey) continue
    const local = localNameIn(decl, request)
    if (local && options.isReusable(local)) return { local, existing: true }
  }
  if (options.isAvailable(options.preferred)) return { local: options.preferred, existing: false }
  for (const candidate of aliasCandidates(options.aliasPrefix, options.preferred)) {
    if (options.isAvailable(candidate)) return { local: candidate, existing: false }
  }
  throw new Error('unreachable: aliasCandidates is infinite')
}

/**
 * Writes the binding {@link planImportBinding} decided on. A named import is
 * merged into an existing declaration of the same module when there is one
 * (`import { Card, CardIcon } from './Card'`, not a second line naming the
 * same file); every other shape gets its own declaration.
 */
export function applyImportBinding(destination: SourceFile, request: ImportRequest, local: string): void {
  const { imported } = request
  if (imported.kind === 'named') {
    const mergeInto = destination
      .getImportDeclarations()
      .find((decl) => importModuleKey(decl) === request.moduleKey && !decl.getNamespaceImport() && decl.isTypeOnly() === request.typeOnly)
    const specifier = local === imported.name ? imported.name : { name: imported.name, alias: local }
    if (mergeInto) {
      mergeInto.addNamedImport(specifier)
      return
    }
    destination.addImportDeclaration({ moduleSpecifier: specifierFor(destination, request), isTypeOnly: request.typeOnly, namedImports: [specifier] })
    return
  }
  destination.addImportDeclaration({
    moduleSpecifier: specifierFor(destination, request),
    isTypeOnly: request.typeOnly,
    ...(imported.kind === 'default' ? { defaultImport: local } : { namespaceImport: local }),
  })
}

/**
 * Carries every side-effect import of `originFile` (`import './Card.css'`)
 * into `destinationFile`, re-specified against the destination's own
 * location, unless the destination already loads that module some other way.
 * A side-effect import has no binding for a free-variable walk to find, so
 * without this a detached component's markup kept its class names and lost
 * the stylesheet that gave them meaning.
 */
export function mirrorSideEffectImports(destinationFile: SourceFile, originFile: SourceFile): void {
  const loaded = new Set(destinationFile.getImportDeclarations().map(importModuleKey))
  for (const decl of originFile.getImportDeclarations()) {
    if (decl.getImportClause()) continue
    const key = importModuleKey(decl)
    if (loaded.has(key)) continue
    const request = importRequestForBinding(decl, { kind: 'default' })
    destinationFile.addImportDeclaration({ moduleSpecifier: specifierFor(destinationFile, request) })
    loaded.add(key)
  }
}

/** How `originFile` itself binds `name`: through one of its imports, or as its own top-level declaration. `undefined` for a global or a name it does not bind at module scope. */
function describeOriginBinding(originFile: SourceFile, name: string): ImportRequest | undefined {
  for (const decl of originFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() === name) return importRequestForBinding(decl, { kind: 'default' })
    if (decl.getNamespaceImport()?.getText() === name) return importRequestForBinding(decl, { kind: 'namespace' })
    const named = decl.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name)
    if (named) return importRequestForBinding(decl, { kind: 'named', name: named.getName() }, named.isTypeOnly())
  }
  const declaredInOrigin =
    originFile.getFunction(name) !== undefined ||
    originFile.getVariableDeclaration(name) !== undefined ||
    originFile.getClass(name) !== undefined
  return declaredInOrigin ? importRequestForExport(originFile, name) : undefined
}

/**
 * Adds imports to `destinationFile` so every name in `identifiers` that
 * `originFile` binds at module scope resolves to the SAME binding there:
 * following an import to the module it actually names (a relative specifier
 * re-resolved against the destination's own location), or importing a
 * top-level declaration FROM `originFile` itself. A global, or a name the
 * origin does not bind, is left alone.
 *
 * Returns the renames the caller must apply to the text it moves: a name the
 * destination already binds to something ELSE is aliased, never trusted — see
 * this module's header. `isNameTaken` lets a caller reserve names this module
 * cannot see (a local that would shadow the new import where the text lands).
 */
export function addReconciledImports(
  destinationFile: SourceFile,
  originFile: SourceFile,
  identifiers: ReadonlySet<string>,
  isNameTaken: (name: string) => boolean = () => false,
): Map<string, string> {
  const renames = new Map<string, string>()
  const taken = topLevelBindingNames(destinationFile)
  const aliasPrefix = path.basename(originFile.getFilePath()).replace(/\..*$/, '')

  for (const name of identifiers) {
    const request = describeOriginBinding(originFile, name)
    if (!request) continue
    const planned = planImportBinding(destinationFile, request, {
      preferred: name,
      aliasPrefix,
      isReusable: (local) => !isNameTaken(local),
      isAvailable: (local) => !taken.has(local) && !isNameTaken(local),
    })
    if (!planned.existing) {
      applyImportBinding(destinationFile, request, planned.local)
      taken.add(planned.local)
    }
    if (planned.local !== name) renames.set(name, planned.local)
  }
  return renames
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
      // A mixed `import Card, { CardIcon } from './Card'` keeps its named
      // half. `removeDefaultImport` rewrites the clause; blanking the
      // identifier's text left `import , { CardIcon }`, which does not parse.
      if (decl.getNamedImports().length === 0 && !decl.getNamespaceImport()) decl.remove()
      else decl.removeDefaultImport()
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
