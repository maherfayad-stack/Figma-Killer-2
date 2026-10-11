/**
 * transplantStateCarry - G-1b, the pure half of "a move gives the element its
 * own copy of the state it uses" (owner decision OD-17). It classifies a name the
 * origin component OWNS, finds the `useState` / `useReducer` / `useRef(init)`
 * statement behind it, and renders that statement for the destination; it never
 * decides what a refusal is (`transplantBindings.ts` does) and never writes.
 *
 * ## What is copied, and what the user is told
 *
 * The STATEMENT is copied, not the state: `const [open, setOpen] = useState(false)`
 * is written again at the top of the destination component, under fresh names
 * when the destination already uses them (`freshName`), with only the slots the
 * element reads (`const [, setOpen] = useState(false)`). The two components then
 * hold two independent states that start from the same initializer. That is a
 * behaviour change, which is why the gesture always says so and offers Undo.
 *
 * ## Why only these three, and where they may go
 *
 *  - `useState`, `useReducer` and `useRef` are the React-owned hooks whose whole
 *    meaning is "a value this component keeps". Their initializer is source text
 *    the walk already follows (a module constant is imported or copied, a prop is
 *    baked or refused, another state is copied first). Nothing is evaluated.
 *  - A custom hook (`useToggle()`) may do anything, and `useCallback`/`useMemo`
 *    close over what they were handed: both refuse by name instead of guessing.
 *  - A hook may only be called unconditionally at the top of a function
 *    component (the rules of hooks). The copy is therefore written before the
 *    first statement of the destination body that can return early, and the move
 *    refuses where that is impossible: no component body, an async component, or
 *    a `'use client'` file moving into one that is a server component.
 */
import { Node, SyntaxKind, VariableDeclarationKind, type Block, type SourceFile, type VariableStatement } from 'ts-morph'
import { reactExportNameOf, type FunctionLike } from '@core/page-parser'
import { applyTextEdits, type TextEdit } from './jsxChildRange'
import { lineIndentAt, reindentBlock } from './jsxChildPlacement'
import { bindingNames, bindingScopeAt, freeVariableReferenceRanges } from './subtreeFreeVariables'

/** The React hooks whose whole meaning is "a value this component keeps" - shared with detach's hoist (`detachHookRead.ts`), which also takes `useId`. */
export const STATE_HOOKS: ReadonlySet<string> = new Set(['useState', 'useReducer', 'useRef'])
const HOOK_NAME_RE = /^use[A-Z0-9]/

/** One `const [a, setA] = useState(init)` (or `useReducer`, or `const ref = useRef(init)`) of the origin component. */
export interface StateHook {
  statement: VariableStatement
  hook: 'useState' | 'useReducer' | 'useRef'
  /** The binding pattern node - `[a, setA]`, or the ref's identifier. */
  pattern: Node
  /** What each slot of the pattern is called; `''` for a skipped slot. A ref has one slot. */
  slots: string[]
}

/** What a name the origin component owns (not a plain declaration) turns out to be. */
export type OwnedBinding =
  | { kind: 'state'; state: StateHook }
  /** `const x = useToggle()`, `useCallback(...)`: a hook result Studio cannot copy honestly. */
  | { kind: 'hook-result'; hook: string }
  /** A parameter of the component, destructured or not. */
  | { kind: 'prop' }
  /** The item or index parameter of the `.map` callback the element sits in. */
  | { kind: 'row' }
  /** A `let`, a destructured `const`, a name declared below the component's top level, anything else. */
  | { kind: 'variable' }

function calleeName(call: Node): string | undefined {
  if (!Node.isCallExpression(call)) return undefined
  const callee = call.getExpression()
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return undefined
}

/** `[a, setA]` / `[, setA]` with plain names; `undefined` for a rest, a default or a nested pattern. */
function arraySlots(pattern: Node): string[] | undefined {
  if (!Node.isArrayBindingPattern(pattern)) return undefined
  const slots: string[] = []
  for (const element of pattern.getElements()) {
    if (Node.isOmittedExpression(element)) {
      slots.push('')
      continue
    }
    if (element.getDotDotDotToken() || element.getInitializer() || !Node.isIdentifier(element.getNameNode())) return undefined
    slots.push(element.getName())
  }
  return slots
}

function readStateStatement(statement: VariableStatement): StateHook | 'custom' | undefined {
  const [declaration] = statement.getDeclarations()
  if (statement.getDeclarationKind() !== VariableDeclarationKind.Const || statement.getDeclarations().length !== 1 || !declaration) return undefined
  const init = declaration.getInitializer()
  const name = init ? calleeName(init) : undefined
  if (!init || !Node.isCallExpression(init) || !name || !HOOK_NAME_RE.test(name)) return undefined
  const react = reactExportNameOf(init.getExpression())
  if (react === undefined || !STATE_HOOKS.has(react)) return 'custom'
  const pattern = declaration.getNameNode()
  if (react === 'useRef') {
    return Node.isIdentifier(pattern)
      ? { statement, hook: 'useRef', pattern, slots: [pattern.getText()] }
      : 'custom'
  }
  const slots = arraySlots(pattern)
  return slots ? { statement, hook: react as 'useState' | 'useReducer', pattern, slots } : 'custom'
}

/** Whether `scope` (the node that binds a name) is the callback of a `.map(...)` call. */
export function isMapCallback(scope: Node | undefined): boolean {
  if (!scope || !(Node.isArrowFunction(scope) || Node.isFunctionExpression(scope))) return false
  const call = scope.getParent()
  if (!call || !Node.isCallExpression(call) || call.getArguments()[0] !== scope) return false
  const callee = call.getExpression()
  return Node.isPropertyAccessExpression(callee) && callee.getName() === 'map'
}

/**
 * What `name` is, when it is something `component` owns. `reference` is a node
 * the name is read from, so a `.map` row parameter (declared in a callback, not
 * at the component's top level) can be told from any other nested binding.
 */
export function classifyOwned(component: FunctionLike, name: string, reference: Node): OwnedBinding {
  for (const parameter of component.getParameters()) {
    if (bindingNames(parameter.getNameNode()).has(name)) return { kind: 'prop' }
  }
  const body = component.getBody()
  if (body && Node.isBlock(body)) {
    for (const statement of body.getStatements()) {
      if (!Node.isVariableStatement(statement)) continue
      if (!statement.getDeclarations().some((declaration) => bindingNames(declaration.getNameNode()).has(name))) continue
      const state = readStateStatement(statement)
      if (state === 'custom') {
        const init = statement.getDeclarations()[0]?.getInitializer()
        return { kind: 'hook-result', hook: (init && calleeName(init)) ?? 'a hook' }
      }
      if (state) return { kind: 'state', state }
      const init = statement.getDeclarations().length === 1 ? statement.getDeclarations()[0]?.getInitializer() : undefined
      const hook = init ? calleeName(init) : undefined
      if (hook && HOOK_NAME_RE.test(hook)) return { kind: 'hook-result', hook }
      return { kind: 'variable' }
    }
  }
  return isMapCallback(bindingScopeAt(reference, name, reference.getSourceFile())) ? { kind: 'row' } : { kind: 'variable' }
}

// ---------------------------------------------------------------------------
// Where a copied hook may be written
// ---------------------------------------------------------------------------

export function hasUseClientDirective(source: SourceFile): boolean {
  for (const statement of source.getStatements()) {
    if (!Node.isExpressionStatement(statement)) return false
    const expression = statement.getExpression()
    if (!Node.isStringLiteral(expression)) return false
    if (expression.getLiteralValue() === 'use client') return true
  }
  return false
}

/**
 * Why a state hook cannot be written into `destination` (the component the
 * element lands in), or `undefined` when it can. A sentence for the person
 * reading the refusal.
 */
export function stateHookRefusal(destination: FunctionLike, origin: SourceFile): string | undefined {
  if (destination.isAsync()) {
    return 'This element uses state, but the component it is going into is async and cannot hold state. Drop it into a client component.'
  }
  if (hasUseClientDirective(origin) && !hasUseClientDirective(destination.getSourceFile())) {
    return 'This element uses state, but the file it is going into has no "use client" at the top and cannot hold state. Drop it into a client component.'
  }
  return undefined
}

function containsOwnReturn(statement: Node, component: Node): boolean {
  return statement.getDescendantsOfKind(SyntaxKind.ReturnStatement).some((ret) => {
    const owner = ret.getAncestors().find((ancestor) => Node.isFunctionLikeDeclaration(ancestor) || Node.isArrowFunction(ancestor))
    return owner === component
  })
}

/**
 * The statement of the destination body a copied hook is written BEFORE: the
 * first statement that can return early (an `if (...) return null` guard) or
 * the one holding the drop container, whichever comes first. A hook written
 * after an early return would be called conditionally.
 */
export function hookInsertionAnchor(body: Block, anchor: Node): Node {
  const component = body.getParent()
  for (const statement of body.getStatements()) {
    if (statement === anchor) return statement
    if (component && containsOwnReturn(statement, component)) return statement
  }
  return anchor
}

// ---------------------------------------------------------------------------
// The copy, as text
// ---------------------------------------------------------------------------

/**
 * The statement as it is written at the destination: the slots the element
 * reads (under their new names, `renames`), every free reference in the
 * initializer re-pointed, re-indented to `toIndent`. The first line carries no
 * indent - the caller places it at a statement start that already has one.
 */
export function stateStatementText(
  state: StateHook,
  used: ReadonlySet<string>,
  originText: string,
  renames: ReadonlyMap<string, string>,
  toIndent: string,
): string {
  const start = state.statement.getStart()
  const edits: TextEdit[] = []
  for (const [name, replacement] of renames) {
    for (const range of freeVariableReferenceRanges(state.statement, name)) {
      edits.push({ start: range.start - start, end: range.end - start, text: replacement })
    }
  }
  const lastUsed = state.slots.reduce((last, slot, index) => (used.has(slot) ? index : last), -1)
  const spell = (slot: string): string => (used.has(slot) ? (renames.get(slot) ?? slot) : '')
  const pattern =
    state.hook === 'useRef' ? spell(state.slots[0]!) : `[${state.slots.slice(0, lastUsed + 1).map(spell).join(', ')}]`
  edits.push({ start: state.pattern.getStart() - start, end: state.pattern.getEnd() - start, text: pattern })
  const text = applyTextEdits(originText.slice(start, state.statement.getEnd()), edits)
  return reindentBlock(text, lineIndentAt(originText, start), toIndent)
}
