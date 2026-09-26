/**
 * subtreeFreeVariables — the free-variable analysis behind
 * `extractSubtreeToComponent.ts`, the reparent/duplicate scope checks, and
 * `detachComponent.ts`'s post-build gate: every name a JSX subtree (or any
 * expression) references that is NOT declared inside it. Every one of those
 * callers' contracts depends on getting this right: a MISSED free variable
 * produces code that references something out of scope — broken code, not a
 * refusal.
 *
 * EVERY identifier counts, not only the ones inside a `{…}`. A
 * `<div {...rest}>` spread attribute holds its expression directly (there is
 * no `JsxExpression` around it), and a detached component can return a
 * non-JSX root (`loading ? <Spinner/> : <List/>`) whose condition sits
 * outside any JSX at all. Walking only expression containers missed both.
 *
 * THE MODEL — nothing in the subtree's own text is ever rewritten
 * -------------------------------------------------------------
 * The subtree moves into the new file byte-for-byte (see
 * `extractSubtreeToComponent.ts`'s `subtreeText`). A reference like
 * `{user.name}`, `{cond ? a : b}`, or a template literal stays EXACTLY as
 * written — this module never touches it. What changes is how each ROOT
 * identifier the subtree references gets BOUND in the new file:
 *
 *   - A name resolvable at the PAGE FILE's own module scope (an import, or a
 *     top-level `const`/`function`/`class` declared directly in the page
 *     file) is mirrored as an import into the new file
 *     (`addReconciledImports`, `./importReconcile`) — `kind: 'import'`.
 *   - Anything else — a destructured prop, a hook's returned binding, a
 *     `const` inside the component's own body — becomes a PROP of the new
 *     component, forwarded at the call site as `name={name}`: the plain
 *     identifier, never a baked value (trap #4 — `{user.name}` resolving to
 *     `"Ada"` and getting written back is exactly the mistake this avoids;
 *     forwarding the BINDING `user`, not the VALUE it currently holds, is
 *     what keeps this honest) — `kind: 'prop'`.
 *
 * A JSX TAG NAME (`<Icon/>`) is a reference too, at its OWN root identifier
 * (`Foo` for `<Foo.Bar/>`) — classified exactly the same way, flagged
 * `isComponentTag` so the caller can type the prop `ComponentType` instead of
 * `unknown`.
 *
 * WHY "HOOKS MOVE WITH THE SUBTREE" HOLDS HERE BUT NOT FOR DETACH
 * ----------------------------------------------------------------
 * `detachComponent.ts` refuses a component that calls a hook, because detach
 * moves the callee's own BODY STATEMENTS (including the hook call) into a
 * DIFFERENT component's body — conditionally, depending on the call site —
 * which can break the rules of hooks or change behaviour silently. Extract
 * never moves a statement at all, only JSX: any hook call written literally
 * inside the subtree's own markup travels with it unexamined (ordinary
 * text), and any VALUE the subtree needs that happens to have come from a
 * hook one call up (`const [open, setOpen] = useState(false)`, then the
 * subtree reads `open`) crosses the boundary the same way every other body-
 * local free variable does — as a plain forwarded prop. The hook call
 * itself, and the state it owns, never move; only the value does. There is
 * no asymmetric case to refuse.
 */
import { Node, SyntaxKind, type SourceFile } from 'ts-morph'
import type { JsxOpeningLikeElement } from './locateJsxElement'

export type FreeVariableKind = 'import' | 'prop'

export interface FreeVariable {
  name: string
  kind: FreeVariableKind
  /** True when EVERY reference to this name inside the subtree is as a JSX tag (a sub-component) — never as a plain value. */
  isComponentTag: boolean
}

/** Global bindings that need neither a mirrored import nor a prop — they resolve at runtime on their own. Deliberately narrow: anything NOT on this list, NOT module-scope, and NOT locally bound within the subtree is treated as a body-local free variable (a prop) rather than silently dropped, because the alternative — assuming it's some untraceable global — risks generating a call site that forwards nothing for a name the new file actually needs. */
const GLOBAL_WHITELIST = new Set([
  'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'console',
  'Date', 'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'Infinity', 'NaN', 'undefined', 'null',
  'window', 'document', 'globalThis',
])

/** Every leaf identifier NAME a binding pattern introduces — `{ a, b: c, ...d }` -> `{a, c, d}`. */
function bindingNames(node: Node): Set<string> {
  const names = new Set<string>()
  if (Node.isIdentifier(node)) {
    names.add(node.getText())
    return names
  }
  if (Node.isObjectBindingPattern(node) || Node.isArrayBindingPattern(node)) {
    for (const el of node.getElements()) {
      if (Node.isBindingElement(el)) {
        for (const n of bindingNames(el.getNameNode())) names.add(n)
      }
    }
  }
  return names
}

/**
 * The scope node (a function, a block, a `for` statement, a catch clause, or
 * the source file) whose own declarations bind `name` for `reference`,
 * searching outward from `reference` up to and including `root`'s own scope —
 * or `undefined` when nothing between them binds it.
 */
function findBindingScope(reference: Node, name: string, root: Node): Node | undefined {
  let current: Node = reference
  while (current !== root) {
    const parent: Node | undefined = current.getParent()
    if (!parent) return undefined

    if (Node.isArrowFunction(parent) || Node.isFunctionExpression(parent) || Node.isFunctionDeclaration(parent)) {
      for (const p of parent.getParameters()) {
        if (bindingNames(p.getNameNode()).has(name)) return parent
      }
      // A named function EXPRESSION binds its own name inside its body.
      if (Node.isFunctionExpression(parent) && parent.getName() === name) return parent
    }

    if (Node.isBlock(parent) || Node.isSourceFile(parent)) {
      for (const stmt of parent.getStatements()) {
        if (Node.isVariableStatement(stmt)) {
          for (const decl of stmt.getDeclarationList().getDeclarations()) {
            if (bindingNames(decl.getNameNode()).has(name)) return parent
          }
        }
        if (Node.isFunctionDeclaration(stmt) && stmt.getName() === name) return parent
        if (Node.isClassDeclaration(stmt) && stmt.getName() === name) return parent
      }
    }

    // `for (const x of xs)`, `for (let i = 0; …)`, `for (const k in o)` —
    // the loop's own initializer binds for the body.
    if (Node.isForOfStatement(parent) || Node.isForInStatement(parent) || Node.isForStatement(parent)) {
      const initializer = parent.getInitializer()
      if (initializer && Node.isVariableDeclarationList(initializer)) {
        for (const decl of initializer.getDeclarations()) {
          if (bindingNames(decl.getNameNode()).has(name)) return parent
        }
      }
    }

    if (Node.isCatchClause(parent)) {
      const decl = parent.getVariableDeclaration()
      if (decl && bindingNames(decl.getNameNode()).has(name)) return parent
    }

    current = parent
  }
  return undefined
}

/**
 * True when `reference` (an identifier somewhere inside `root`'s subtree)
 * resolves to a binding introduced BETWEEN itself and `root` — a nested
 * arrow/function's own parameter, or a `const`/`let`/`function` declared
 * anywhere in an enclosing block that is itself still inside the subtree.
 * `false` means the name is free: bound outside the subtree entirely (a
 * component parameter, a hook result, a page-level const) or not bound
 * anywhere this walk can see (module scope, or nothing — left to the
 * caller to classify further).
 */
function isLocallyBound(reference: Node, name: string, root: Node): boolean {
  return findBindingScope(reference, name, root) !== undefined
}

/**
 * How `name` resolves at `position` inside `sourceFile`, by a static scope
 * walk: `'local'` — bound below module scope (a parameter, a body `const`, a
 * loop variable); `'module'` — an import or a top-level declaration of the
 * file; `'none'` — neither (a global, or nothing at all). Nothing is
 * evaluated.
 */
export type BindingKind = 'local' | 'module' | 'none'

/**
 * The node whose scope binds `name` at `position` — the `Block`, function or
 * loop that declares it — or `undefined` when nothing in the file does (a
 * global, or nothing at all). DET-3's gate asks it which component a moved
 * hook's binding landed in; `bindingKindAt` is the coarse form of the same walk.
 */
export function bindingScopeAt(position: Node, name: string, sourceFile: SourceFile): Node | undefined {
  return findBindingScope(position, name, sourceFile)
}

export function bindingKindAt(position: Node, name: string, sourceFile: SourceFile): BindingKind {
  const scope = findBindingScope(position, name, sourceFile)
  if (scope && !Node.isSourceFile(scope)) return 'local'
  if (scope || isPageModuleScopeName(sourceFile, name)) return 'module'
  return 'none'
}

/** True when `id` sits inside a JSX tag-name position (either element in `<Foo.Bar/>`) anywhere between it and the nearest enclosing `JsxOpeningElement`/`JsxSelfClosingElement`/`JsxClosingElement` — tag names are collected separately (`collectTagNameOpenings`), so a general identifier walk must not also treat them as ordinary value references. */
function isWithinTagName(id: Node): boolean {
  for (const ancestor of id.getAncestors()) {
    if (Node.isJsxOpeningElement(ancestor) || Node.isJsxSelfClosingElement(ancestor) || Node.isJsxClosingElement(ancestor)) {
      const tagName = ancestor.getTagNameNode()
      return id.getStart() >= tagName.getStart() && id.getEnd() <= tagName.getEnd()
    }
  }
  return false
}

/**
 * True when `id` is used as a REFERENCE — excludes property-access names
 * (`.name` in `user.name`), non-computed object-literal/binding property keys,
 * method and accessor names, JSX attribute names (plain and `ns:name`),
 * declaration names (parameters, variables, functions, classes), labels,
 * import/export specifier names and `import.meta` — all of which are
 * syntactically `Identifier` nodes but never reference an outer binding.
 * Exported: `detachComponent.ts` walks the component's own JSX with the same
 * rule, so the two can never disagree about what "a reference" is.
 */
export function isReferenceIdentifier(id: Node): boolean {
  const parent = id.getParent()
  if (!parent) return true
  const pos = id.getStart()
  const isNameOf = (node: { getNameNode(): Node | undefined }): boolean => node.getNameNode()?.getStart() === pos

  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode().getStart() === pos) return false
  if (Node.isPropertyAssignment(parent) && parent.getNameNode().getStart() === pos) return false
  if (
    (Node.isFunctionDeclaration(parent) || Node.isFunctionExpression(parent) || Node.isClassDeclaration(parent) || Node.isClassExpression(parent)) &&
    isNameOf(parent)
  ) {
    return false
  }
  if (
    (Node.isMethodDeclaration(parent) || Node.isGetAccessorDeclaration(parent) || Node.isSetAccessorDeclaration(parent) || Node.isPropertyDeclaration(parent)) &&
    isNameOf(parent)
  ) {
    return false
  }
  if (Node.isJsxNamespacedName(parent)) return false
  if (Node.isMetaProperty(parent)) return false
  if (Node.isLabeledStatement(parent) || Node.isBreakStatement(parent) || Node.isContinueStatement(parent)) return false
  if (
    Node.isImportSpecifier(parent) ||
    Node.isImportClause(parent) ||
    Node.isNamespaceImport(parent) ||
    Node.isExportSpecifier(parent) ||
    Node.isImportEqualsDeclaration(parent)
  ) {
    return false
  }
  if (Node.isBindingElement(parent)) {
    if (parent.getNameNode().getStart() === pos) return false
    const propertyName = parent.getPropertyNameNode()
    if (propertyName && propertyName.getStart() === pos) return false
  }
  if (Node.isParameterDeclaration(parent) && parent.getNameNode().getStart() === pos) return false
  if (Node.isVariableDeclaration(parent) && parent.getNameNode().getStart() === pos) return false
  if (Node.isJsxAttribute(parent)) {
    const nameNode = parent.getNameNode()
    if (Node.isIdentifier(nameNode) && nameNode.getStart() === pos) return false
  }
  if (isWithinTagName(id)) return false

  return true
}

/**
 * The binding a JSX tag name reads, or `undefined` for an intrinsic element.
 * `<Card/>` reads `Card`; `<motion.div/>` and `<Icons.Home/>` read their root
 * segment (a member tag is always a reference, whatever its case); `<div/>`,
 * `<svg:rect/>` and `<this.X/>` read no binding.
 */
export function tagReferenceRoot(tagNameNode: Node): string | undefined {
  const text = tagNameNode.getText()
  const rootSegment = text.split('.')[0]!
  if (!/^[A-Za-z_$][\w$]*$/.test(rootSegment) || rootSegment === 'this') return undefined
  if (!text.includes('.') && !/^[A-Z]/.test(rootSegment)) return undefined
  return rootSegment
}

/** Every JSX opening tag (self-closing, or the opening half of a paired element) in `root`'s own subtree, INCLUDING `root` itself when `root` carries a tag. */
function collectTagNameOpenings(root: Node): JsxOpeningLikeElement[] {
  const openings: JsxOpeningLikeElement[] = []
  if (Node.isJsxSelfClosingElement(root)) openings.push(root)
  if (Node.isJsxElement(root)) openings.push(root.getOpeningElement())
  for (const el of root.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) openings.push(el)
  for (const el of root.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) openings.push(el)
  return openings
}

/** Every name `pageFile` itself resolves at MODULE scope: an import, or a top-level `const`/`function`/`class` declared directly in the file (outside any function body). */
function isPageModuleScopeName(pageFile: SourceFile, name: string): boolean {
  for (const decl of pageFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() === name) return true
    if (decl.getNamespaceImport()?.getText() === name) return true
    if (decl.getNamedImports().some((n) => (n.getAliasNode()?.getText() ?? n.getNameNode().getText()) === name)) return true
  }
  if (pageFile.getFunction(name)) return true
  if (pageFile.getClass(name)) return true
  if (pageFile.getVariableDeclaration(name)) return true
  return false
}

/**
 * True when `node` sits entirely within one of `excluded`'s own ranges — used
 * by `extractSubtreeToComponent.ts`'s E2.2 keep/slot toggle to keep a SLOTTED
 * child's own references out of this analysis. A slotted child's JSX text
 * never moves into the new file (see that module's own doc) — it stays in the
 * PAGE file, relocated from being `root`'s child to being the call site's own
 * attribute/child — so nothing inside it needs a mirrored import or a
 * forwarded prop; it already resolves wherever it always did.
 */
function isWithinExcluded(node: Node, excluded: readonly Node[]): boolean {
  const start = node.getStart()
  const end = node.getEnd()
  return excluded.some((ex) => start >= ex.getStart() && end <= ex.getEnd())
}

/**
 * The full free-variable partition for `root`'s subtree, in first-reference
 * order. Every name is classified exactly once — `kind: 'import'` when
 * `pageFile` resolves it at module scope, `kind: 'prop'` otherwise — except
 * names in `GLOBAL_WHITELIST`, which are dropped (they need neither).
 *
 * `excluded` (default none — every existing caller/test is unaffected) names
 * zero or more of `root`'s own descendant subtrees whose references should
 * NOT be collected — see `isWithinExcluded`'s own doc.
 */
export function analyzeFreeVariables(root: Node, pageFile: SourceFile, excluded: readonly Node[] = []): FreeVariable[] {
  const order: string[] = []
  const kinds = new Map<string, FreeVariableKind>()
  const isTag = new Map<string, boolean>()

  function record(name: string, tagReference: boolean): void {
    if (GLOBAL_WHITELIST.has(name)) return
    if (!kinds.has(name)) {
      order.push(name)
      kinds.set(name, isPageModuleScopeName(pageFile, name) ? 'import' : 'prop')
      isTag.set(name, tagReference)
    } else if (!tagReference) {
      // Seen again as a plain value reference somewhere else — no longer
      // "only ever a tag", so the caller must not type it as a component.
      isTag.set(name, false)
    }
  }

  // Pass 1 — JSX tag names (component references), including `root`'s own.
  for (const opening of collectTagNameOpenings(root)) {
    if (isWithinExcluded(opening, excluded)) continue
    const tagNameNode = opening.getTagNameNode()
    const rootSegment = tagReferenceRoot(tagNameNode)
    if (!rootSegment) continue
    if (isLocallyBound(tagNameNode, rootSegment, root)) continue
    record(rootSegment, true)
  }

  // Pass 2 — every other reference, at whatever depth: inside a `{…}`, a
  // `{...spread}` attribute, or a non-JSX root expression. Nothing here is
  // rewritten; only OBSERVED, so the moved JSX text is never touched.
  for (const id of freeReferenceIdentifiers(root)) {
    if (isWithinExcluded(id, excluded)) continue
    record(id.getText(), false)
  }

  return order.map((name) => ({ name, kind: kinds.get(name)!, isComponentTag: isTag.get(name)! }))
}

/**
 * Every reference identifier inside `root` (including `root` itself) that
 * nothing between it and `root` binds — JSX tag names excluded (they are
 * pass 1 of {@link analyzeFreeVariables}). The raw material of every
 * free-variable question in this module.
 */
function freeReferenceIdentifiers(root: Node): Node[] {
  const out: Node[] = []
  const candidates = Node.isIdentifier(root) ? [root] : root.getDescendantsOfKind(SyntaxKind.Identifier)
  for (const id of candidates) {
    if (!isReferenceIdentifier(id)) continue
    if (isLocallyBound(id, id.getText(), root)) continue
    out.push(id)
  }
  return out
}

/**
 * The distinct names `root` reads from outside itself — JSX tag roots and
 * every other reference, in first-reference order, unclassified. What a
 * caller needs when it only asks "could any of these be captured or
 * rebound", not "how would each be carried".
 */
export function freeReferenceNames(root: Node): string[] {
  const names = new Set<string>()
  for (const opening of collectTagNameOpenings(root)) {
    const rootSegment = tagReferenceRoot(opening.getTagNameNode())
    if (!rootSegment) continue
    if (isLocallyBound(opening.getTagNameNode(), rootSegment, root)) continue
    names.add(rootSegment)
  }
  for (const id of freeReferenceIdentifiers(root)) names.add(id.getText())
  return [...names]
}

/**
 * The names `subtree` captures that would NOT resolve if the subtree were
 * written at `destination` instead — the honesty check behind W4-1's
 * cross-parent move (`moveJsxElement`'s reparent form).
 *
 * A reparent moves markup, not the bindings it reads. Within one component
 * that is free: the subtree keeps every name it had, and moving DEEPER only
 * adds more (a `.map` callback's parameter is visible to everything inside it).
 * Two shapes are not free, and this is what catches them:
 *
 *   - moving OUT of a nested scope — a row lifted out of `items.map(item => …)`
 *     leaves `item` behind,
 *   - moving ACROSS components in the same file — `<Card>`'s `props.title` means
 *     nothing inside `<Page>`.
 *
 * Both would produce a file that no longer compiles, which is worse than a
 * refusal by every measure. The caller refuses and NAMES the variables, because
 * "some binding" is not something a person can act on.
 *
 * `kind: 'import'` free variables are skipped: they resolve at the page file's
 * own module scope, which is visible from every position in that file. Only
 * body-local names (`kind: 'prop'`) can stop resolving.
 *
 * This is a STATIC scope walk, deliberately: it asks which declarations enclose
 * the destination, never what any of them hold. Nothing is evaluated.
 */
export function freeVariablesOutOfScopeAt(subtree: Node, destination: Node, pageFile: SourceFile): string[] {
  const out: string[] = []
  for (const variable of analyzeFreeVariables(subtree, pageFile)) {
    if (variable.kind === 'import') continue
    if (isLocallyBound(destination, variable.name, pageFile)) continue
    out.push(variable.name)
  }
  return out
}
