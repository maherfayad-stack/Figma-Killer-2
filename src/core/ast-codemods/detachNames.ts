/**
 * detachNames — how a name the component's markup reads from OUTSIDE the
 * component (its file's module scope, or a global) is written in the page:
 * the same symbol already visible at the call site is kept as-is; a global
 * must not be shadowed there; anything else becomes an import — an
 * equivalent one reused, else the original name when it is free, else an
 * ALIAS (`styles` -> `cardStyles`). Also the ledger of what every emitted
 * name must bind to, which the post-build gate in `detachComponent.ts`
 * checks. Plans only; `detachComponent.ts` writes.
 */
import { Node, SymbolFlags, SyntaxKind, type SourceFile, type Symbol as MorphSymbol, type TypeChecker } from 'ts-morph'
import {
  importRequestForBinding,
  importRequestForExport,
  planImportBinding,
  topLevelBindingNames,
  type ImportRequest,
} from './importReconcile'
import { freeReferenceNames } from './subtreeFreeVariables'
import { fail, isImportBinding, isTopLevelDeclaration } from './detachSource'
import type { JsxOpeningLikeElement } from './locateJsxElement'

/**
 * How a name in the detached markup must bind in the page: as it did at the
 * call site, to a module-scope binding, to nothing (a global), or — DET-3 — to
 * a context reader's result at the top of the enclosing component (`hook`).
 */
export type Expectation = 'call-site' | 'module' | 'global' | 'hook'

export interface PendingImport {
  request: ImportRequest
  local: string
}

export class DetachNameResolver {
  readonly expected = new Map<string, Set<Expectation>>()
  readonly imports: PendingImport[] = []
  private readonly reserved = new Set<string>()
  private readonly outerNames = new Map<unknown, string>()
  private readonly callSiteScope = new Map<string, MorphSymbol>()
  private readonly pageTopLevel: Set<string>
  private readonly pageFreeNames: Set<string>
  private readonly checker: TypeChecker
  private readonly page: SourceFile
  private readonly componentFile: SourceFile
  private readonly componentName: string
  private readonly fnIdentifierNames: ReadonlySet<string>

  constructor(
    checker: TypeChecker,
    page: SourceFile,
    componentFile: SourceFile,
    componentName: string,
    opening: JsxOpeningLikeElement,
    fnIdentifierNames: ReadonlySet<string>,
  ) {
    this.checker = checker
    this.page = page
    this.componentFile = componentFile
    this.componentName = componentName
    this.fnIdentifierNames = fnIdentifierNames
    const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias
    for (const symbol of checker.getSymbolsInScope(opening, meaning)) {
      if (!this.callSiteScope.has(symbol.getName())) this.callSiteScope.set(symbol.getName(), symbol)
    }
    this.pageTopLevel = topLevelBindingNames(page)
    this.pageFreeNames = new Set(freeReferenceNames(page))
  }

  expect(name: string, kind: Expectation): void {
    let kinds = this.expected.get(name)
    if (!kinds) this.expected.set(name, (kinds = new Set()))
    kinds.add(kind)
  }

  expectCallSiteNames(names: ReadonlySet<string>): void {
    for (const name of names) this.expect(name, 'call-site')
  }

  private canonical(symbol: MorphSymbol): unknown {
    return this.checker.getExportSymbolOfSymbol(symbol).compilerSymbol
  }

  private declaredInPage(symbol: MorphSymbol | undefined): boolean {
    return symbol?.getDeclarations().some((d) => d.getSourceFile() === this.page) ?? false
  }

  /** The name a module-scope or global reference is written as in the page — planning the import it needs. */
  outerName(id: Node, symbol: MorphSymbol | undefined, decl: Node | undefined): string {
    const name = id.getText()
    const cacheKey = symbol ? this.canonical(symbol) : `?${name}`
    const cached = this.outerNames.get(cacheKey)
    if (cached !== undefined) return cached
    const resolved = this.resolveOuterName(name, symbol, decl)
    this.outerNames.set(cacheKey, resolved)
    return resolved
  }

  private resolveOuterName(name: string, symbol: MorphSymbol | undefined, decl: Node | undefined): string {
    const atCallSite = this.callSiteScope.get(name)
    const isGlobal = !decl || decl.getSourceFile() !== this.componentFile
    if (symbol && atCallSite && this.canonical(atCallSite) === this.canonical(symbol)) {
      this.expect(name, isGlobal ? 'global' : 'module')
      return name
    }
    if (isGlobal) {
      if (atCallSite && this.declaredInPage(atCallSite)) {
        fail(
          'name-collision',
          `${this.componentName} reads the global \`${name}\`, and this page declares its own \`${name}\` where the markup would land — a global can't be aliased.`,
        )
      }
      this.expect(name, 'global')
      return name
    }
    if (this.componentFile === this.page) {
      fail(
        'name-collision',
        `${this.componentName} reads \`${name}\` from this file's module scope, and the call site's component declares its own \`${name}\` — inlined, the markup would read the wrong one.`,
      )
    }
    const request = this.importRequestFor(name, decl)
    const planned = planImportBinding(this.page, request, {
      preferred: name,
      aliasPrefix: this.componentName,
      isReusable: (local) => {
        const symbol = this.callSiteScope.get(local)
        const importedHere = symbol?.getDeclarations().some((d) => isImportBinding(d) && d.getSourceFile() === this.page) ?? false
        return importedHere && (local === name || !this.fnIdentifierNames.has(local))
      },
      isAvailable: (local) => this.isNameAvailable(local, name),
    })
    if (!planned.existing) {
      this.imports.push({ request, local: planned.local })
      this.reserved.add(planned.local)
    }
    this.expect(planned.local, 'module')
    return planned.local
  }

  /** Holds `local` for a binding the plan will write, so no later import or hook binding takes it. */
  reserve(local: string): void {
    this.reserved.add(local)
  }

  /** Whether a NEW binding may be named `local` without changing what anything else in the page — or in the markup — means. */
  isNameAvailable(local: string, originalName: string): boolean {
    if (this.reserved.has(local) || this.pageTopLevel.has(local) || this.pageFreeNames.has(local)) return false
    if (local !== originalName && this.fnIdentifierNames.has(local)) return false
    return !this.declaredInPage(this.callSiteScope.get(local))
  }

  private importRequestFor(name: string, decl: Node): ImportRequest {
    if (isImportBinding(decl)) {
      const importDecl = decl.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration)
      if (Node.isImportClause(decl)) return importRequestForBinding(importDecl, { kind: 'default' })
      if (Node.isNamespaceImport(decl)) return importRequestForBinding(importDecl, { kind: 'namespace' })
      if (Node.isImportSpecifier(decl)) return importRequestForBinding(importDecl, { kind: 'named', name: decl.getName() }, decl.isTypeOnly())
    }
    if (isTopLevelDeclaration(decl)) {
      const exportNames: string[] = []
      for (const [exportName, declarations] of this.componentFile.getExportedDeclarations()) {
        if (declarations.includes(decl as never)) exportNames.push(exportName)
      }
      const exportName = exportNames.includes(name) ? name : exportNames[0]
      if (exportName === undefined) {
        fail(
          'unbound-reference',
          `${this.componentName}'s markup reads \`${name}\`, which ${this.componentFile.getBaseName()} declares but does not export — the page has no way to import it. Export it, or duplicate the component and edit the copy.`,
        )
      }
      return importRequestForExport(this.componentFile, exportName)
    }
    fail(
      'unbound-reference',
      `${this.componentName}'s markup reads \`${name}\` from the scope around the component, which the page can't reach.`,
    )
  }

  /** `Fragment` for a keyed fragment root, from `react`, bound the same careful way as any other import. */
  fragmentBinding(): string {
    const request: ImportRequest = {
      moduleKey: 'react',
      target: { kind: 'bare', specifier: 'react' },
      imported: { kind: 'named', name: 'Fragment' },
      typeOnly: false,
    }
    const planned = planImportBinding(this.page, request, {
      preferred: 'Fragment',
      aliasPrefix: 'React',
      isReusable: (local) => this.callSiteScope.get(local)?.getDeclarations().some((d) => isImportBinding(d) && d.getSourceFile() === this.page) ?? false,
      isAvailable: (local) => this.isNameAvailable(local, 'Fragment'),
    })
    if (!planned.existing) {
      this.imports.push({ request, local: planned.local })
      this.reserved.add(planned.local)
    }
    this.expect(planned.local, 'module')
    return planned.local
  }
}
