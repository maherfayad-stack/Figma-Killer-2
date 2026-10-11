/**
 * detachHooks — DET-3 / G-3: the hooks a detach may MOVE, and where they go.
 *
 * A detached component's markup lands inside another component's body — the
 * one that encloses the call site. A hook cannot come with it as markup: the
 * rules of hooks put every hook call at the top level of a function
 * component. So a hook the markup reads is moved to the TOP of the enclosing
 * component, and the markup reads the binding there. Two kinds move:
 *
 * **A CONTEXT READER** — `useContext` itself, or a custom hook whose body is
 * only `useContext` (and a `useMemo` of it), the shape Tier B's provider trace
 * already recognises (`isContextReaderHook`, `@core/page-parser`). Under one
 * provider a context reader returns the same value to every component, so
 * reading it one level up changes nothing that renders. If the enclosing
 * component already makes the SAME call its binding is reused.
 *
 * **A STATE HOLDER (G-3, OD-23)** — `useState`, `useReducer`, `useRef`. The
 * instance's state becomes the enclosing component's own, under fresh names
 * (two detached instances never share a `value`): what the detached markup
 * reads and sets is still one piece of state, it just lives one component up.
 * That is a behaviour change — the state now survives the markup being
 * hidden, and the page re-renders when it changes — so it is reported
 * (`movedHooks`) before anything is written, and it is only done where it is
 * true to the instance:
 *   - the call site is not inside a function (a `.map` row, a callback, a
 *     render helper), because one hoisted state would be shared by every row
 *     that function renders;
 *   - the initial value is self-contained: a literal, plain data of literals,
 *     or a module-scope name — never a prop or a body value.
 * Everything else that holds state or runs effects (`useEffect`, `useMemo`
 * of a prop, an arbitrary custom hook) keeps refusing `uses-hooks`; the
 * editor answers with a component copy instead.
 *
 * The shape a movable hook must have, all of it checked:
 *   - a top-level `const` of the component's body, initialised by the call;
 *   - bound to one name, destructured one level with plain names
 *     (`const { t, lang: language } = useLanguage()`), or — a state holder —
 *     an array pattern of plain names (`const [value, setValue] = useState('')`);
 *   - arguments that are literals, or (for `useContext` and a state holder)
 *     a name the component's module scope declares — never a prop or a body value.
 *
 * Where it goes (decided lazily, only for the hooks the markup reads):
 *   - the enclosing component already makes the SAME context call (same hook
 *     declaration, same arguments) as a top-level `const`: its binding is
 *     REUSED — a destructured key it already has is read by its local name, a
 *     missing key is added to its pattern, and a whole-value binding is read
 *     as `value.key`;
 *   - otherwise a new `const` is written as the component's FIRST statement,
 *     under names nothing in that component already uses. A concise arrow
 *     body (`() => (<main/>)`) becomes a block with a `return`.
 *   - a call site that is not inside a function component (a module-level
 *     JSX const, a lowercase render helper) has nowhere to call a hook:
 *     `uses-hooks`.
 *   - a state holder out of a `'use client'` file into a page that is not one
 *     makes the page a client component (`useClient`), so it still builds.
 *
 * Plans only. `detachComponent.ts` writes, and its gate checks that every
 * moved binding binds, at the markup's new position, to the enclosing
 * component's own top-level scope.
 */
import * as path from 'node:path'
import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
  type ArrayBindingPattern,
  type ObjectBindingPattern,
  type SourceFile,
  type Symbol as MorphSymbol,
  type VariableStatement,
} from 'ts-morph'
import { getFunctionLikeNode, isContextReaderHook, reactExportNameOf, type FunctionLike } from '@core/page-parser'
import { fail, isWithin, type Value } from './detachSource'
import type { DetachNameResolver } from './detachNames'

const HOOK_CALL_RE = /^use[A-Z0-9]/

/** One key of a destructured hook result: the binding the component reads, and the key it reads it from. */
interface HookKey {
  decl: Node
  key: string
  local: string
}

/** One slot of an array-destructured state hook (`const [value, setValue] = useState('')`): where it sits, and the name it is bound to. */
interface HookSlot {
  decl: Node
  index: number
  local: string
}

type HookBinding =
  | { kind: 'whole'; decl: Node; local: string }
  | { kind: 'keys'; keys: HookKey[] }
  | { kind: 'slots'; slots: HookSlot[] }

/** A hook call in the component's body that may be moved — see this module's doc for the shape. */
export interface ComponentHook {
  statement: VariableStatement
  call: CallExpression
  /** What the user reads in a confirm: `useLanguage`. */
  label: string
  binding: HookBinding
  /** The declaration the callee resolves to — two calls are the same hook when these match. `undefined` for a state holder, which is never shared. */
  identity: unknown
  /** `useState` / `useReducer` / `useRef`: the instance's own state, hoisted under fresh names and never reused. */
  state: boolean
}

/** A text edit to the page, applied by `detachComponent.ts` (descending by `pos`). */
export interface PageTextEdit {
  pos: number
  /** Characters replaced at `pos` (0 for an insertion). */
  remove: number
  text: string
}

// ---------------------------------------------------------------------------
// The component side: which hooks it calls, and may they move
// ---------------------------------------------------------------------------

function calleeName(call: CallExpression): string | undefined {
  const callee = call.getExpression()
  if (Node.isIdentifier(callee)) return callee.getText()
  if (Node.isPropertyAccessExpression(callee)) return callee.getName()
  return undefined
}

function resolvedDeclaration(symbol: MorphSymbol | undefined): Node | undefined {
  if (!symbol) return undefined
  const target = symbol.isAlias() ? symbol.getAliasedSymbol() ?? symbol : symbol
  return target.getDeclarations()[0]
}

/** The identity of the hook `call` invokes, when it is a context reader — `undefined` for any other hook. */
function contextReaderIdentity(call: CallExpression): unknown {
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

const STATE_HOOKS: ReadonlySet<string> = new Set(['useState', 'useReducer', 'useRef'])

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
 * Every hook call in `fn`'s body, each one checked movable - or a
 * `uses-hooks` refusal naming the first that is not.
 */
export function readComponentHooks(fn: FunctionLike, componentName: string): ComponentHook[] {
  const hooks: ComponentHook[] = []
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
      for (const arg of call.getArguments()) {
        if (!isSelfContainedInitializer(arg, fn)) {
          fail('uses-hooks', `${componentName} starts ${name} from a value its own props or body compute, which the enclosing component does not have.`)
        }
      }
    } else {
      for (const arg of call.getArguments()) {
        const outerName = Node.isIdentifier(arg) && !isWithin(resolvedDeclaration(arg.getSymbol()) ?? fn, fn)
        if (!isLiteralArgument(arg) && !(identity === 'react:useContext' && outerName)) {
          fail('uses-hooks', `${componentName} passes ${name} a value its own props or body compute, which the enclosing component does not have.`)
        }
      }
    }
    hooks.push({ statement, call, label: name, binding: readHookBinding(decl.getNameNode(), componentName, name, state), identity, state })
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
      return { statement, call, label, binding: readHookBinding(nameNode, '', label, false), identity, state: false }
    } catch {
      return 'unmovable'
    }
  }
  return undefined
}

function readHookBinding(nameNode: Node, componentName: string, hookName: string, state: boolean): ComponentHook['binding'] {
  if (Node.isIdentifier(nameNode)) return { kind: 'whole', decl: nameNode.getParentOrThrow(), local: nameNode.getText() }
  if (state && Node.isArrayBindingPattern(nameNode)) return readSlots(nameNode, componentName, hookName)
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

function readSlots(pattern: ArrayBindingPattern, componentName: string, hookName: string): ComponentHook['binding'] {
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

// ---------------------------------------------------------------------------
// The page side: the component that encloses the call site
// ---------------------------------------------------------------------------

const TRANSPARENT_WRAPPERS = new Set(['memo', 'forwardRef'])

/** Whether `fn` is a function component: a capitalised name (through `memo`/`forwardRef`), or a default export. */
function isFunctionComponent(fn: Node): boolean {
  if (Node.isFunctionDeclaration(fn)) {
    const name = fn.getName()
    return name ? /^[A-Z]/.test(name) : fn.isDefaultExport()
  }
  if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return false
  if (Node.isFunctionExpression(fn) && /^[A-Z]/.test(fn.getName() ?? '')) return true
  let holder: Node | undefined = fn.getParent()
  while (
    holder &&
    (Node.isParenthesizedExpression(holder) ||
      Node.isAsExpression(holder) ||
      Node.isSatisfiesExpression(holder) ||
      (Node.isCallExpression(holder) && TRANSPARENT_WRAPPERS.has(reactExportNameOf(holder.getExpression()) ?? '')))
  ) {
    holder = holder.getParent()
  }
  if (!holder) return false
  if (Node.isVariableDeclaration(holder)) return /^[A-Z]/.test(holder.getName())
  return Node.isExportAssignment(holder)
}

/** The nearest function component around `node`, skipping callbacks and render helpers — `undefined` at module scope. */
export function enclosingFunctionComponent(node: Node): FunctionLike | undefined {
  for (const ancestor of node.getAncestors()) {
    if ((Node.isFunctionDeclaration(ancestor) || Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) && isFunctionComponent(ancestor)) {
      return ancestor
    }
  }
  return undefined
}

/** Whether `node` renders once per row: it sits inside a `.map(…)` callback below `stop`. */
export function rendersPerRow(node: Node, stop: Node | undefined): boolean {
  for (const ancestor of node.getAncestors()) {
    if (ancestor === stop) return false
    if (!Node.isArrowFunction(ancestor) && !Node.isFunctionExpression(ancestor)) continue
    const call = ancestor.getParent()
    if (!Node.isCallExpression(call) || !(call.getArguments() as Node[]).includes(ancestor)) continue
    const callee = call.getExpression()
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'map') return true
  }
  return false
}

function lineIndent(sourceFile: SourceFile, pos: number): string {
  const text = sourceFile.getFullText()
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))![0]
}

/** An existing top-level `const x = hook(args)` of the enclosing component, and how it binds. */
interface PageHookCall {
  identity: unknown
  argKeys: string[]
  binding: { kind: 'whole'; local: string } | { kind: 'keys'; keys: Map<string, string>; pattern: ObjectBindingPattern }
}

/** The one reading of an argument two calls must agree on: a literal's text, or the declaration a name resolves to. */
function argumentKey(arg: Node): string {
  if (Node.isIdentifier(arg)) {
    const decl = resolvedDeclaration(arg.getSymbol())
    return decl ? `decl:${decl.getSourceFile().getFilePath()}:${decl.getStart()}` : `global:${arg.getText()}`
  }
  return `literal:${arg.getText()}`
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** How the markup reads one hook binding in the page. */
interface PageRead {
  text: string
  free: ReadonlySet<string>
}

export class DetachHookPlan {
  /** Hooks for which a NEW call was written into the page — what a pre-commit confirm names. */
  readonly movedHooks: string[] = []
  /** Every page-side local a read goes through; the gate checks each binds in `component`'s own body. */
  readonly boundLocals = new Set<string>()
  readonly edits: PageTextEdit[] = []
  /** G-3 - the `'use client'` directive the page needs once a state holder lands in it, as the component's own file spells it. */
  useClient: string | undefined

  private readonly byDecl = new Map<Node, { hook: ComponentHook; key?: string }>()
  private readonly placed = new Map<ComponentHook, (key: string | undefined) => PageRead>()
  private readonly component: FunctionLike | undefined
  private readonly callSite: Node
  private readonly page: SourceFile
  private readonly names: DetachNameResolver
  private readonly componentName: string
  private pageCalls: PageHookCall[] | undefined
  private takenNames: Set<string> | undefined
  private concise: { newStatements: string[] } | undefined

  constructor(hooks: readonly ComponentHook[], page: SourceFile, callSite: Node, names: DetachNameResolver, componentName: string) {
    this.page = page
    this.names = names
    this.componentName = componentName
    this.callSite = callSite
    for (const hook of hooks) {
      if (hook.binding.kind === 'whole') this.byDecl.set(hook.binding.decl, { hook })
      else if (hook.binding.kind === 'keys') for (const key of hook.binding.keys) this.byDecl.set(key.decl, { hook, key: key.key })
      else for (const slot of hook.binding.slots) this.byDecl.set(slot.decl, { hook, key: String(slot.index) })
    }
    this.component = enclosingFunctionComponent(callSite)
  }

  owns(decl: Node): boolean {
    return this.byDecl.has(decl)
  }

  /** How the markup reads `decl` (a hook's binding) in the page — planning the move on first use. */
  read(decl: Node): PageRead {
    const owner = this.byDecl.get(decl)!
    let place = this.placed.get(owner.hook)
    if (!place) {
      place = this.place(owner.hook)
      this.placed.set(owner.hook, place)
    }
    const read = place(owner.key)
    for (const name of read.free) this.boundLocals.add(name)
    return read
  }

  /** `read` as a planner `Value`, with every page-side name it reads recorded for the gate (`hook`). */
  value(decl: Node): Value {
    const read = this.read(decl)
    for (const name of read.free) this.names.expect(name, 'hook')
    return { expr: () => read.text, primary: true, free: read.free }
  }

  /** Writes the new statements a concise-bodied component needs, once every hook is placed. */
  finish(): void {
    if (!this.concise || this.concise.newStatements.length === 0 || !this.component) return
    const body = this.component.getBody()!
    const base = lineIndent(this.page, this.component.getStart())
    const indent = `${base}  `
    const head = `{\n${this.concise.newStatements.map((s) => `${indent}${s}\n`).join('')}${indent}return `
    this.edits.push({ pos: body.getStart(), remove: 0, text: head }, { pos: body.getEnd(), remove: 0, text: `\n${base}}` })
  }

  private place(hook: ComponentHook): (key: string | undefined) => PageRead {
    const component = this.component
    if (!component) {
      fail(
        'uses-hooks',
        `${this.componentName} uses ${hook.label}(), and this call site is not inside a function component — there is nowhere to call it. Duplicate the component and edit the copy instead.`,
      )
    }
    if (hook.state) {
      this.assertStateIsHoistable(component, hook)
      return this.writeNewCall(component, hook)
    }
    const existing = this.findPageCall(component, hook)
    if (existing) {
      const reuse = this.reuse(hook, existing)
      if (reuse) return reuse
    }
    return this.writeNewCall(component, hook)
  }

  /**
   * A state holder moves up only when the call site renders exactly once per
   * render of the enclosing component. Inside any function (a `.map` row, a
   * callback, a render helper) it may render any number of times, and one
   * hoisted state would be shared by all of them.
   */
  private assertStateIsHoistable(component: FunctionLike, hook: ComponentHook): void {
    for (const ancestor of this.callSite.getAncestors()) {
      if (ancestor === component) return
      if (Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor) || Node.isMethodDeclaration(ancestor)) {
        fail(
          'uses-hooks',
          `${this.componentName} keeps its own state in ${hook.label}(), and this call site sits inside a function that can run once per row or per call - hoisting one state into the page would share it between them.`,
        )
      }
    }
  }

  private findPageCall(component: FunctionLike, hook: ComponentHook): PageHookCall | undefined {
    if (!this.pageCalls) {
      this.pageCalls = []
      const body = component.getBody()
      if (body && Node.isBlock(body)) {
        for (const statement of body.getStatements()) {
          if (!Node.isVariableStatement(statement) || statement.getDeclarationKind() !== VariableDeclarationKind.Const) continue
          for (const decl of statement.getDeclarations()) {
            const init = decl.getInitializer()
            if (!init || !Node.isCallExpression(init)) continue
            const identity = contextReaderIdentity(init)
            if (identity === undefined) continue
            const nameNode = decl.getNameNode()
            let binding: PageHookCall['binding'] | undefined
            if (Node.isIdentifier(nameNode)) binding = { kind: 'whole', local: nameNode.getText() }
            else if (Node.isObjectBindingPattern(nameNode) && nameNode.getElements().every((e) => !e.getDotDotDotToken() && !e.getInitializer() && Node.isIdentifier(e.getNameNode()))) {
              const keys = new Map<string, string>()
              for (const element of nameNode.getElements()) {
                const property = element.getPropertyNameNode()
                keys.set(property ? property.getText() : element.getName(), element.getName())
              }
              binding = { kind: 'keys', keys, pattern: nameNode }
            }
            if (binding) this.pageCalls.push({ identity, argKeys: init.getArguments().map(argumentKey), binding })
          }
        }
      }
    }
    const argKeys = hook.call.getArguments().map(argumentKey)
    return this.pageCalls.find((call) => call.identity === hook.identity && call.argKeys.join('|') === argKeys.join('|'))
  }

  /** Read through the page's own call of the same hook, when its binding can say what the component's does. */
  private reuse(hook: ComponentHook, existing: PageHookCall): ((key: string | undefined) => PageRead) | undefined {
    const pageBinding = existing.binding
    if (hook.binding.kind === 'whole') {
      if (pageBinding.kind !== 'whole') return undefined
      return () => ({ text: pageBinding.local, free: new Set([pageBinding.local]) })
    }
    if (pageBinding.kind === 'whole') {
      return (key) => ({ text: /^[A-Za-z_$][\w$]*$/.test(key!) ? `${pageBinding.local}.${key}` : `${pageBinding.local}[${JSON.stringify(key)}]`, free: new Set([pageBinding.local]) })
    }
    return (key) => {
      let local = pageBinding.keys.get(key!)
      if (local === undefined) {
        local = this.freshName(hook.binding.kind === 'keys' ? hook.binding.keys.find((k) => k.key === key)!.local : key!)
        pageBinding.keys.set(key!, local)
        const elements = pageBinding.pattern.getElements()
        const last = elements.at(-1)
        const element = local === key ? local : `${keyText(key!)}: ${local}`
        if (last) this.edits.push({ pos: last.getEnd(), remove: 0, text: `, ${element}` })
        else this.edits.push({ pos: pageBinding.pattern.getStart() + 1, remove: 0, text: ` ${element} ` })
      }
      return { text: local, free: new Set([local]) }
    }
  }

  private writeNewCall(component: FunctionLike, hook: ComponentHook): (key: string | undefined) => PageRead {
    const callee = hook.call.getExpression()
    const calleeText = Node.isPropertyAccessExpression(callee)
      ? `${this.outer(callee.getExpression())}.${callee.getName()}`
      : this.outer(callee)
    const typeArguments = hook.call.getTypeArguments()
    const typeText = typeArguments.length > 0 ? `<${typeArguments.map((type) => type.getText()).join(', ')}>` : ''
    const args = hook.call.getArguments().map((arg) => (Node.isIdentifier(arg) && arg.getText() !== 'undefined' ? this.outer(arg) : arg.getText()))
    const locals = new Map<string | undefined, string>()
    let pattern: string
    if (hook.binding.kind === 'whole') {
      const local = this.freshName(hook.binding.local)
      locals.set(undefined, local)
      pattern = local
    } else if (hook.binding.kind === 'slots') {
      const parts: string[] = []
      for (const slot of hook.binding.slots) {
        const local = this.freshName(slot.local)
        locals.set(String(slot.index), local)
        parts[slot.index] = local
      }
      pattern = `[${Array.from(parts, (part) => part ?? '').join(', ')}]`
    } else {
      const parts: string[] = []
      for (const key of hook.binding.keys) {
        const local = this.freshName(key.local)
        locals.set(key.key, local)
        parts.push(local === key.key ? local : `${keyText(key.key)}: ${local}`)
      }
      pattern = `{ ${parts.join(', ')} }`
    }
    const statement = `const ${pattern} = ${calleeText}${typeText}(${args.join(', ')})`
    this.movedHooks.push(hook.label)
    if (hook.state) this.useClient ??= missingClientDirective(hook.statement.getSourceFile(), this.page)
    const body = component.getBody()
    if (body && Node.isBlock(body)) {
      const first = body.getStatements()[0]
      const pos = first ? first.getStart() : body.getEnd() - 1
      const indent = first ? lineIndent(this.page, first.getStart()) : `${lineIndent(this.page, component.getStart())}  `
      this.edits.push({ pos, remove: 0, text: first ? `${statement}\n${indent}` : `${indent}${statement}\n` })
    } else {
      this.concise ??= { newStatements: [] }
      this.concise.newStatements.push(statement)
    }
    return (key) => {
      const local = locals.get(key)!
      return { text: local, free: new Set([local]) }
    }
  }

  /** A module-scope name the new call reads, written as the page must spell it (an import planned when needed). */
  private outer(id: Node): string {
    const symbol = id.getSymbol()
    return this.names.outerName(id, symbol, symbol?.getDeclarations()[0])
  }

  /** `preferred`, or `preferred2`, `preferred3`… — the first name nothing in the enclosing component or the page already means. */
  private freshName(preferred: string): string {
    if (!this.takenNames) {
      this.takenNames = new Set(this.component?.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()) ?? [])
    }
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? preferred : `${preferred}${n}`
      if (this.takenNames.has(candidate) || !this.names.isNameAvailable(candidate, candidate)) continue
      this.takenNames.add(candidate)
      this.names.reserve(candidate)
      return candidate
    }
  }
}

/** The `'use client'` directive of `from`, as written there, when `to` lacks one - what a state holder moved from one into the other needs. */
function missingClientDirective(from: SourceFile, to: SourceFile): string | undefined {
  const directive = (file: SourceFile): string | undefined => {
    for (const statement of file.getStatements()) {
      const expression = Node.isExpressionStatement(statement) ? statement.getExpression() : undefined
      if (!expression || !Node.isStringLiteral(expression)) return undefined
      if (expression.getLiteralValue() === 'use client') return expression.getText()
    }
    return undefined
  }
  const wanted = directive(from)
  return wanted !== undefined && directive(to) === undefined ? wanted : undefined
}

function keyText(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}
