/**
 * detachHookRead - the COMPONENT side of DET-3 / G-3: which hook calls in the
 * detached component may move into the page's component, and the shape each
 * must have (`detachHooks.ts` owns the page side - where they go, and under
 * what names). Pure reads of the component's file; never writes.
 *
 * What may move, and why, is in `detachHooks.ts`'s module doc: a CONTEXT
 * READER (one provider, so the same value one level up) and a STATE HOLDER
 * (`useState` / `useReducer` / `useRef` / `useId`, the instance's own state
 * under fresh names, reported before it is written). Everything else that
 * holds state or runs effects refuses `uses-hooks`.
 */
import * as path from 'node:path'
import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
  type ArrayBindingPattern,
  type Symbol as MorphSymbol,
  type VariableStatement,
} from 'ts-morph'
import { getFunctionLikeNode, isContextReaderHook, reactExportNameOf, type FunctionLike } from '@core/page-parser'
import { fail, isWithin } from './detachSource'
import { isReferenceIdentifier } from './subtreeFreeVariables'

const HOOK_CALL_RE = /^use[A-Z0-9]/

/** One key of a destructured hook result: the binding the component reads, and the key it reads it from. */
export interface HookKey {
  decl: Node
  key: string
  local: string
}

/** One slot of an array-destructured state hook (`const [value, setValue] = useState('')`): where it sits, and the name it is bound to. */
export interface HookSlot {
  decl: Node
  index: number
  local: string
}

/** What every movable hook call carries. */
interface HookBase {
  statement: VariableStatement
  call: CallExpression
  /** What the user reads in a confirm: `useLanguage`. */
  label: string
  /**
   * Arguments computed from the component's own props (`useDir(dir)`): the call
   * site's values are written in their place, which the planner renders
   * (`DetachHookPlan`'s `renderArgument`). Every other argument is copied as is.
   */
  fromProps: ReadonlySet<Node>
}

/** A CONTEXT READER in the component's body that may be moved - see this module's doc for the shape. */
export interface ComponentHook extends HookBase {
  binding: { kind: 'whole'; decl: Node; local: string } | { kind: 'keys'; keys: HookKey[] }
  /** The declaration the callee resolves to - two calls are the same hook when these match. */
  identity: unknown
  state: false
}

/**
 * G-3 - a STATE HOLDER (`useState` / `useReducer` / `useRef` / `useId`): the
 * instance's own state, hoisted under fresh names and never reused.
 */
export interface StateHook extends HookBase {
  binding: { kind: 'whole'; decl: Node; local: string } | { kind: 'slots'; slots: HookSlot[] }
  state: true
}

export type MovableHook = ComponentHook | StateHook

// ---------------------------------------------------------------------------
// The component side: which hooks it calls, and may they move
// ---------------------------------------------------------------------------

function calleeName(call: CallExpression): string | undefined {
  const callee = call.getExpression()
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return undefined
}

export function resolvedDeclaration(symbol: MorphSymbol | undefined): Node | undefined {
  if (!symbol) return undefined
  const target = symbol.isAlias() ? symbol.getAliasedSymbol() ?? symbol : symbol
  return target.getDeclarations()[0]
}

/** The identity of the hook `call` invokes, when it is a context reader — `undefined` for any other hook. */
export function contextReaderIdentity(call: CallExpression): unknown {
  const callee = call.getExpression()
  if (reactExportNameOf(callee) === 'useContext') return 'react:useContext'
  if (!Node.isIdentifier(callee)) return undefined
  const decl = resolvedDeclaration(callee.getSymbol())
  const fn = decl ? getFunctionLikeNode(decl) : undefined
  return fn && isContextReaderHook(fn) ? fn.compilerNode : undefined
}

/**
 * Best-effort: adds the file `call`'s callee is imported from to `call`'s own
 * ts-morph project, when it isn't already a member. A single-file (or
 * two-file) project's checker cannot resolve a cross-file symbol to a real
 * declaration otherwise — {@link contextReaderIdentity} would see an alias
 * with nothing behind it and read that as "not a context reader" rather than
 * "don't know yet". Silently does nothing for a bare specifier (an npm
 * package — `useState` from `'react'` needs no such help; it is never a
 * context reader either way) or a relative one that doesn't resolve to a
 * real file on disk.
 */
function preloadImportTarget(call: CallExpression): void {
  const callee = call.getExpression()
  if (!Node.isIdentifier(callee)) return
  const name = callee.getText()
  const sourceFile = call.getSourceFile()
  const importDecl = sourceFile
    .getImportDeclarations()
    .find(
      (d) =>
        d.getDefaultImport()?.getText() === name ||
        d.getNamedImports().some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name),
    )
  const specifier = importDecl?.getModuleSpecifierValue()
  if (!specifier || !specifier.startsWith('.')) return
  const project = sourceFile.getProject()
  const base = path.resolve(path.dirname(sourceFile.getFilePath()), specifier)
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`]) {
    if (project.getSourceFile(candidate)) return
    if (project.addSourceFileAtPathIfExists(candidate)) return
  }
}

function isLiteralArgument(arg: Node): boolean {
  return (
    Node.isStringLiteral(arg) ||
    Node.isNoSubstitutionTemplateLiteral(arg) ||
    Node.isNumericLiteral(arg) ||
    Node.isTrueLiteral(arg) ||
    Node.isFalseLiteral(arg) ||
    Node.isNullLiteral(arg)
  )
}

const STATE_HOOKS: ReadonlySet<string> = new Set(['useState', 'useReducer', 'useRef', 'useId'])

/** `useState` / `useReducer` / `useRef` when `call` is React's own (through `React.useState` or a renamed import), else `undefined`. */
function stateHookName(call: CallExpression): string | undefined {
  const name = reactExportNameOf(call.getExpression())
  return name !== undefined && STATE_HOOKS.has(name) ? name : undefined
}

/** Keyword and literal types: a type argument that means the same in any file. */
const PLAIN_TYPE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.StringKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.UnknownKeyword,
  SyntaxKind.AnyKeyword,
  SyntaxKind.NeverKeyword,
  SyntaxKind.LiteralType,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
])

const TS_LIB_FILE = /[\\/]typescript[\\/]lib[\\/]lib\./

/**
 * A type argument the page can spell identically: plain keyword/literal types,
 * arrays, unions and tuples of them, and a type the TypeScript lib declares
 * (`HTMLInputElement`) - never a name the component's own file defines or imports.
 */
function isPortableType(type: Node): boolean {
  if (PLAIN_TYPE_KINDS.has(type.getKind())) return true
  if (Node.isArrayTypeNode(type)) return isPortableType(type.getElementTypeNode())
  if (Node.isParenthesizedTypeNode(type)) return isPortableType(type.getTypeNode())
  if (Node.isUnionTypeNode(type) || Node.isIntersectionTypeNode(type)) return type.getTypeNodes().every(isPortableType)
  if (Node.isTupleTypeNode(type)) return type.getElements().every(isPortableType)
  if (Node.isTypeReference(type)) {
    const declarations = type.getTypeName().getSymbol()?.getDeclarations() ?? []
    const fromLib = declarations.length > 0 && declarations.every((d) => TS_LIB_FILE.test(d.getSourceFile().getFilePath()))
    return fromLib && type.getTypeArguments().every(isPortableType)
  }
  return false
}

/** Plain data a hook can be given in any component: literals, and arrays/objects/negations of them. */
function isPlainData(node: Node): boolean {
  if (isLiteralArgument(node)) return true
  if (Node.isParenthesizedExpression(node)) return isPlainData(node.getExpression())
  if (Node.isPrefixUnaryExpression(node)) return isPlainData(node.getOperand())
  if (Node.isArrayLiteralExpression(node)) return node.getElements().every(isPlainData)
  if (Node.isObjectLiteralExpression(node)) {
    return node.getProperties().every((property) => {
      if (!Node.isPropertyAssignment(property)) return false
      const initializer = property.getInitializer()
      return !Node.isComputedPropertyName(property.getNameNode()) && initializer !== undefined && isPlainData(initializer)
    })
  }
  return Node.isIdentifier(node) && node.getText() === 'undefined'
}

/**
 * What a state holder may be given to start from: plain data, or ONE name the
 * component's module scope (or a global) declares - written into the page by
 * the same import planning every other module-scope name gets. A prop or a
 * body value has no meaning at the top of the enclosing component.
 */
function isSelfContainedInitializer(arg: Node, fn: FunctionLike): boolean {
  if (isPlainData(arg)) return true
  if (!Node.isIdentifier(arg)) return false
  const declaration = resolvedDeclaration(arg.getSymbol())
  return declaration === undefined || !isWithin(declaration, fn)
}

/**
 * An argument made only of the component's own props, module-scope names and
 * literals (`dir`, `props.initial`, `size ?? 'm'`): the call site supplies the
 * props, so the planner can write the same argument in terms of it. A body
 * value, or anything with a function in it, has no such reading.
 */
function isDerivedFromProps(arg: Node, fn: FunctionLike): boolean {
  if (arg.getDescendantsOfKind(SyntaxKind.ArrowFunction).length > 0 || arg.getDescendantsOfKind(SyntaxKind.FunctionExpression).length > 0) return false
  const identifiers = Node.isIdentifier(arg) ? [arg] : arg.getDescendantsOfKind(SyntaxKind.Identifier)
  let readsProp = false
  for (const id of identifiers) {
    if (!isReferenceIdentifier(id)) continue
    const declaration = resolvedDeclaration(id.getSymbol())
    if (!declaration || !isWithin(declaration, fn)) continue
    const parameter = declaration.getFirstAncestor((ancestor) => Node.isParameterDeclaration(ancestor)) ?? (Node.isParameterDeclaration(declaration) ? declaration : undefined)
    if (!parameter || !fn.getParameters().includes(parameter as never)) return false
    readsProp = true
  }
  return readsProp
}

/**
 * Every hook call in `fn`'s body, each one checked movable - or a
 * `uses-hooks` refusal naming the first that is not.
 */
export function readComponentHooks(fn: FunctionLike, componentName: string): MovableHook[] {
  const hooks: MovableHook[] = []
  const body = fn.getBody()
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeName(call)
    if (!name || !HOOK_CALL_RE.test(name)) continue
    const identity = contextReaderIdentity(call)
    const state = identity === undefined && stateHookName(call) !== undefined
    if (identity === undefined && !state) {
      fail(
        'uses-hooks',
        `${componentName} uses ${name} - detach moves a hook that reads a context (like useLanguage()) or holds state (useState, useReducer, useRef); effects and other hooks stay with a component.`,
      )
    }
    const decl = call.getParent()
    const statement = Node.isVariableDeclaration(decl) ? decl.getVariableStatement() : undefined
    if (
      !Node.isVariableDeclaration(decl) ||
      decl.getInitializer() !== call ||
      !statement ||
      statement.getParent() !== body ||
      statement.getDeclarationKind() !== VariableDeclarationKind.Const
    ) {
      fail('uses-hooks', `${componentName} calls ${name} somewhere other than a top-level \`const\` of its body, so there is no single call to move.`)
    }
    if (state) {
      for (const type of call.getTypeArguments()) {
        if (!isPortableType(type)) {
          fail('uses-hooks', `${componentName} types ${name}<${type.getText()}> with a type the page does not have, which detach can't carry over.`)
        }
      }
    }
    const fromProps = new Set<Node>()
    for (const arg of call.getArguments()) {
      const own = state
        ? isSelfContainedInitializer(arg, fn)
        : isLiteralArgument(arg) || (identity === 'react:useContext' && Node.isIdentifier(arg) && !isWithin(resolvedDeclaration(arg.getSymbol()) ?? fn, fn))
      if (own) continue
      if (isDerivedFromProps(arg, fn)) {
        fromProps.add(arg)
        continue
      }
      fail(
        'uses-hooks',
        state
          ? `${componentName} starts ${name} from a value its body computes, which the enclosing component does not have.`
          : `${componentName} passes ${name} a value its body computes, which the enclosing component does not have.`,
      )
    }
    if (state) {
      hooks.push({ statement, call, label: name, binding: readStateBinding(decl.getNameNode(), componentName, name), state: true, fromProps })
    } else {
      hooks.push({ statement, call, label: name, binding: readContextBinding(decl.getNameNode(), componentName, name), identity, state: false, fromProps })
    }
  }
  return hooks
}

/**
 * The context-hook binding named `name` in `fn`'s own top-level body, when
 * there is one — the cross-file transplant's use of this module
 * (`transplantJsxElement.ts`): a captured free variable that turns out to be
 * `const { t } = useLanguage()` (or a whole-value binding) can travel by
 * re-establishing the CALL at the destination, exactly as DET-3 re-establishes
 * it one component up. `undefined` when nothing in `fn`'s body binds `name` to
 * a hook call at all — an ordinary prop or local, which stays a refusal.
 * `'unmovable'` when something DOES bind it to a hook call, but not one this
 * module's rules allow to move (not a context reader, a non-literal argument,
 * or a binding shape `readHookBinding` can't move) — the caller keeps its
 * ordinary captured-scope refusal rather than guessing.
 *
 * Deliberately narrower than {@link readComponentHooks}: that function fails
 * the WHOLE component the moment any one of its hook calls is unmovable,
 * which is correct when the component's entire body is about to move
 * (detach). A transplant moves only markup, not the rest of the component, so
 * an unrelated `useState` elsewhere in the same component is none of its
 * business — only the ONE hook binding the captured name actually needs.
 */
export function findHookBindingForName(fn: FunctionLike, name: string): ComponentHook | 'unmovable' | undefined {
  const body = fn.getBody()
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    // A plain identifier callee only — `transplantJsxElement.ts` carries the
    // hook's own import by that same name, and re-spells a property-access
    // callee (`i18n.useTranslation()`) wrong.
    if (!Node.isIdentifier(call.getExpression())) continue
    const label = calleeName(call)
    if (!label || !HOOK_CALL_RE.test(label)) continue
    const decl = call.getParent()
    const statement = Node.isVariableDeclaration(decl) ? decl.getVariableStatement() : undefined
    if (
      !Node.isVariableDeclaration(decl) ||
      decl.getInitializer() !== call ||
      !statement ||
      statement.getParent() !== body ||
      statement.getDeclarationKind() !== VariableDeclarationKind.Const
    ) {
      continue
    }
    const nameNode = decl.getNameNode()
    const boundNames = Node.isIdentifier(nameNode)
      ? [nameNode.getText()]
      : Node.isObjectBindingPattern(nameNode)
        ? nameNode
            .getElements()
            .flatMap((el) => (Node.isBindingElement(el) && Node.isIdentifier(el.getNameNode()) ? [el.getNameNode().getText()] : []))
        : []
    if (!boundNames.includes(name)) continue

    // A cross-file transplant's own ts-morph project loads only the origin
    // and destination files (`createProject`/`loadSourceFile` in
    // `transplantJsxElement.ts`, unlike detach's whole-workspace project) —
    // the hook's OWN declaration file is not a member of it yet, and without
    // that the checker cannot resolve the callee's symbol to a real function
    // body for `contextReaderIdentity` to read. Loaded here, once, on the
    // candidate that actually matters, rather than the whole workspace.
    preloadImportTarget(call)
    const identity = contextReaderIdentity(call)
    if (identity === undefined) return 'unmovable'
    for (const arg of call.getArguments()) {
      if (!isLiteralArgument(arg)) return 'unmovable'
    }
    try {
      return { statement, call, label, binding: readContextBinding(nameNode, '', label), identity, state: false, fromProps: new Set() }
    } catch {
      return 'unmovable'
    }
  }
  return undefined
}

function readContextBinding(nameNode: Node, componentName: string, hookName: string): ComponentHook['binding'] {
  if (Node.isIdentifier(nameNode)) return { kind: 'whole', decl: nameNode.getParentOrThrow(), local: nameNode.getText() }
  if (!Node.isObjectBindingPattern(nameNode)) {
    fail('uses-hooks', `${componentName} unpacks ${hookName}() in a way detach can't move (an array pattern).`)
  }
  const keys: HookKey[] = []
  for (const element of nameNode.getElements()) {
    const local = element.getNameNode()
    const property = element.getPropertyNameNode()
    const key = property ? (Node.isIdentifier(property) ? property.getText() : Node.isStringLiteral(property) ? property.getLiteralValue() : undefined) : local.getText()
    if (element.getDotDotDotToken() || element.getInitializer() || !Node.isIdentifier(local) || key === undefined) {
      fail('uses-hooks', `${componentName} unpacks ${hookName}() with a default, a rest or a nested pattern, which detach can't move.`)
    }
    keys.push({ decl: element, key, local: local.getText() })
  }
  return { kind: 'keys', keys }
}

function readStateBinding(nameNode: Node, componentName: string, hookName: string): StateHook['binding'] {
  if (Node.isIdentifier(nameNode)) return { kind: 'whole', decl: nameNode.getParentOrThrow(), local: nameNode.getText() }
  if (!Node.isArrayBindingPattern(nameNode)) {
    fail('uses-hooks', `${componentName} unpacks ${hookName}() in a way detach can't move (an object pattern).`)
  }
  return readSlots(nameNode, componentName, hookName)
}

function readSlots(pattern: ArrayBindingPattern, componentName: string, hookName: string): StateHook['binding'] {
  const slots: HookSlot[] = []
  pattern.getElements().forEach((element, index) => {
    if (Node.isOmittedExpression(element)) return
    const local = element.getNameNode()
    if (element.getDotDotDotToken() || element.getInitializer() || !Node.isIdentifier(local)) {
      fail('uses-hooks', `${componentName} unpacks ${hookName}() with a default, a rest or a nested pattern, which detach can't move.`)
    }
    slots.push({ decl: element, index, local: local.getText() })
  })
  return { kind: 'slots', slots }
}
