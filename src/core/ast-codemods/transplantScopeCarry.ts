/**
 * transplantScopeCarry - the pure half of "a cross-file move carries the
 * plain values and handlers the element reads" (G-1a). It answers three
 * questions about the ORIGIN file and renders the answer as text; it never
 * decides what a refusal is (`transplantBindings.ts` does) and never writes.
 *
 *  - **What does this name refer to?** `findLocalBinding` looks it up in the
 *    origin component: a top-level `const name = <expr>` or `function name()`
 *    of its body is a declaration that may travel; a parameter, a destructured
 *    prop, a `.map` row, a hook result (`useState`, `useRef`, a custom hook)
 *    or a `let` is not - those are values the component OWNS, and moving them
 *    is a behaviour change (G-1b/G-1c), so they keep refusing by name.
 *  - **Is the declaration copyable?** `isCopyableModuleDeclaration` is the same
 *    question for a helper the origin declares at module level without
 *    exporting it. A non-exported constant or function is copied rather than
 *    exported: exporting from a route file (`app/page.tsx`) is itself invalid in
 *    some frameworks, and it would make a drag edit a third place in the origin.
 *    A COMPONENT (capitalised, has lowercase) is never copied - two copies of a
 *    component are two components - so it keeps refusing `unexported-binding`.
 *  - **What does the copy look like at the destination?** `declarationText`
 *    renders the origin's own bytes with the renames the move needs (an alias for
 *    a clashing name, a re-pointed hook read) and re-indents them; the
 *    declaration is otherwise written verbatim, nothing is evaluated or baked.
 *
 * Parse only. Whether `const total = price * qty` is "pure" is not decided by
 * running it: it is decided by what it READS, which `transplantBindings.ts`
 * resolves name by name until every leaf is an import, a global, a context
 * hook it can re-establish, or another declaration that qualifies.
 */
import { Node, SyntaxKind, VariableDeclarationKind, type FunctionDeclaration, type SourceFile, type VariableStatement } from 'ts-morph'
import type { FunctionLike } from '@core/page-parser'
import { applyTextEdits, type TextEdit } from './jsxChildRange'
import { reindentBlock, lineIndentAt } from './jsxChildPlacement'
import { bindingNames, freeVariableReferenceRanges, isReferenceIdentifier } from './subtreeFreeVariables'

const HOOK_CALL_RE = /^use[A-Z0-9]/

/** A statement the carry can copy: `const name = <expr>` (one declarator) or `function name() {}`. */
export type CarriableDeclaration = VariableStatement | FunctionDeclaration

export type LocalBinding = { kind: 'declaration'; statement: CarriableDeclaration } | { kind: 'owned' }

/** Whether `node` calls a hook anywhere - a call to `useX(...)` or `React.useX(...)`. */
function callsHook(node: Node): boolean {
  const calls = node.getDescendantsOfKind(SyntaxKind.CallExpression)
  if (Node.isCallExpression(node)) calls.push(node)
  return calls.some((call) => {
    const callee = call.getExpression()
    const name = Node.isIdentifier(callee) ? callee.getText() : Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined
    return name !== undefined && HOOK_CALL_RE.test(name)
  })
}

/** A name that reads as a component: starts uppercase and has a lowercase letter (`Card`, not `TABS`). */
export function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name) && /[a-z]/.test(name)
}

/**
 * What `name` is in `component`'s own scope: a declaration that may travel,
 * or something the component owns (a prop, a row, state, a `let`, anything
 * declared below the component's top level, or a shape this walk does not copy).
 */
export function findLocalBinding(component: FunctionLike, name: string): LocalBinding {
  for (const parameter of component.getParameters()) {
    if (bindingNames(parameter.getNameNode()).has(name)) return { kind: 'owned' }
  }
  const body = component.getBody()
  if (!body || !Node.isBlock(body)) return { kind: 'owned' }
  for (const statement of body.getStatements()) {
    if (Node.isFunctionDeclaration(statement) && statement.getName() === name) {
      return callsHook(statement) ? { kind: 'owned' } : { kind: 'declaration', statement }
    }
    if (!Node.isVariableStatement(statement)) continue
    const declaration = statement.getDeclarations().find((candidate) => bindingNames(candidate.getNameNode()).has(name))
    if (!declaration) continue
    const initializer = declaration.getInitializer()
    const copyable =
      statement.getDeclarationKind() === VariableDeclarationKind.Const &&
      statement.getDeclarations().length === 1 &&
      Node.isIdentifier(declaration.getNameNode()) &&
      initializer !== undefined &&
      !callsHook(initializer)
    return copyable ? { kind: 'declaration', statement } : { kind: 'owned' }
  }
  return { kind: 'owned' }
}

/** The module-level statement declaring `name` in `source`, when it has the shape this carry knows how to copy. */
export function findModuleDeclaration(source: SourceFile, name: string): CarriableDeclaration | undefined {
  const fn = source.getFunction(name)
  if (fn) return fn.getOverloads().length === 0 && !fn.isDefaultExport() ? fn : undefined
  const statement = source.getVariableDeclaration(name)?.getVariableStatement()
  if (!statement) return undefined
  const [declaration] = statement.getDeclarations()
  return statement.getDeclarationKind() === VariableDeclarationKind.Const &&
    statement.getDeclarations().length === 1 &&
    declaration !== undefined &&
    Node.isIdentifier(declaration.getNameNode()) &&
    declaration.getInitializer() !== undefined
    ? statement
    : undefined
}

/** The identifier a carriable declaration introduces. */
function declarationNameNode(statement: CarriableDeclaration): Node | undefined {
  return Node.isFunctionDeclaration(statement) ? statement.getNameNode() : statement.getDeclarations()[0]?.getNameNode()
}

const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * The declaration's bytes, with `renames` applied to every free reference to a
 * renamed name AND to the declaration's own name, then re-indented from where
 * it was written to where it will be. The first line carries no indent - the
 * caller places it at a statement start that already has one.
 */
export function declarationText(
  statement: CarriableDeclaration,
  originText: string,
  renames: ReadonlyMap<string, string>,
  toIndent: string,
): string {
  const start = statement.getStart()
  const edits: TextEdit[] = []
  for (const [name, replacement] of renames) {
    for (const range of freeVariableReferenceRanges(statement, name)) {
      edits.push({ start: range.start - start, end: range.end - start, text: replacement })
    }
  }
  const nameNode = declarationNameNode(statement)
  const renamedSelf = nameNode ? renames.get(nameNode.getText()) : undefined
  if (nameNode && renamedSelf !== undefined) {
    edits.push({ start: nameNode.getStart() - start, end: nameNode.getEnd() - start, text: renamedSelf })
  }
  const text = applyTextEdits(originText.slice(start, statement.getEnd()), edits)
  return reindentBlock(text, lineIndentAt(originText, start), toIndent)
}

/** Whether `scope` (a module or a component body) already declares `name` as exactly `text` - the same declaration, written again. */
export function declaresIdentically(scope: SourceFile | { getStatements(): Node[] }, name: string, text: string): boolean {
  const wanted = normalizeWhitespace(text)
  return scope.getStatements().some((statement) => {
    const nameNode = Node.isFunctionDeclaration(statement) || Node.isVariableStatement(statement) ? declarationNameNode(statement) : undefined
    return nameNode?.getText() === name && normalizeWhitespace(statement.getText()) === wanted
  })
}

/**
 * Every name `source` already uses: references, declarations and import
 * bindings - but not property names, JSX attribute names or object keys, which
 * are spelled the same without being the same thing. A carried declaration may
 * not take any of them, or it would capture (or be captured by) code that
 * means something else by the same word.
 */
export function namesInUse(source: SourceFile): Set<string> {
  const used = new Set<string>()
  for (const id of source.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const parent = id.getParent()
    const declares =
      (Node.isVariableDeclaration(parent) || Node.isParameterDeclaration(parent) || Node.isFunctionDeclaration(parent) || Node.isClassDeclaration(parent) || Node.isBindingElement(parent)) &&
      parent.getNameNode() === id
    const imports = Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent)
    if (declares || imports || isReferenceIdentifier(id)) used.add(id.getText())
  }
  return used
}
