/**
 * subtreeFreeVariables — the free-variable analysis behind
 * `extractSubtreeToComponent.ts`: every name a JSX subtree references that
 * is NOT declared inside the subtree itself. Generalizes
 * `detachComponent.ts`'s `referencedIdentifiers` (which only ever needed the
 * single root identifier of one `JsxExpression`'s own top-level expression,
 * because detach substitutes into a known param name) into a real free-
 * variable partition, because extraction's whole contract depends on getting
 * this right: a MISSED free variable produces a new component file that
 * references something out of scope — broken code, not a refusal.
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
  let current: Node = reference
  while (current !== root) {
    const parent: Node | undefined = current.getParent()
    if (!parent) return false

    if (Node.isArrowFunction(parent) || Node.isFunctionExpression(parent) || Node.isFunctionDeclaration(parent)) {
      for (const p of parent.getParameters()) {
        if (bindingNames(p.getNameNode()).has(name)) return true
      }
    }

    if (Node.isBlock(parent) || Node.isSourceFile(parent)) {
      for (const stmt of parent.getStatements()) {
        if (Node.isVariableStatement(stmt)) {
          for (const decl of stmt.getDeclarationList().getDeclarations()) {
            if (bindingNames(decl.getNameNode()).has(name)) return true
          }
        }
        if (Node.isFunctionDeclaration(stmt) && stmt.getName() === name) return true
      }
    }

    if (Node.isCatchClause(parent)) {
      const decl = parent.getVariableDeclaration()
      if (decl && bindingNames(decl.getNameNode()).has(name)) return true
    }

    current = parent
  }
  return false
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

/** True when `id` is used as a VALUE reference — excludes property-access names (`.name` in `user.name`), non-computed object-literal/binding property keys, JSX attribute names, and declaration names (parameters, variable declarations) — all of which are syntactically `Identifier` nodes but never reference an outer binding. */
function isReferenceIdentifier(id: Node): boolean {
  const parent = id.getParent()
  if (!parent) return true
  const pos = id.getStart()

  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode().getStart() === pos) return false
  if (Node.isPropertyAssignment(parent) && parent.getNameNode().getStart() === pos) return false
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
    const rootSegment = tagNameNode.getText().split('.')[0]!
    if (!/^[A-Z]/.test(rootSegment)) continue // lowercase — an intrinsic HTML element, not a reference
    if (isLocallyBound(tagNameNode, rootSegment, root)) continue
    record(rootSegment, true)
  }

  // Pass 2 — every value reference inside a `{…}` (attribute value or JSX
  // child expression), at whatever depth. Nothing here is rewritten; only
  // OBSERVED, so the moved JSX text is never touched.
  for (const jsxExpr of root.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
    if (isWithinExcluded(jsxExpr, excluded)) continue
    const expr = jsxExpr.getExpression()
    if (!expr) continue

    const candidates = Node.isIdentifier(expr) ? [expr] : expr.getDescendantsOfKind(SyntaxKind.Identifier)
    for (const id of candidates) {
      if (!isReferenceIdentifier(id)) continue
      const name = id.getText()
      if (isLocallyBound(id, name, root)) continue
      record(name, false)
    }
  }

  return order.map((name) => ({ name, kind: kinds.get(name)!, isComponentTag: isTag.get(name)! }))
}
