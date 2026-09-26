/**
 * detachHooks — DET-3: the hooks a detach may MOVE, and where they go.
 *
 * A detached component's markup lands inside another component's body — the
 * one that encloses the call site. A hook cannot come with it as markup: the
 * rules of hooks put every hook call at the top level of a function
 * component. So a hook the markup reads is moved to the TOP of the enclosing
 * component, and the markup reads the binding there.
 *
 * That is honest for exactly one kind of hook: a CONTEXT READER — `useContext`
 * itself, or a custom hook whose body is only `useContext` (and a `useMemo` of
 * it), the shape Tier B's provider trace already recognises
 * (`isContextReaderHook`, `@core/page-parser`). Under one provider a context
 * reader returns the same value to every component, so reading it one level
 * up changes nothing that renders. Every other hook (`useState`, `useEffect`,
 * `useRef`, an arbitrary custom hook) holds state or runs effects: hoisting
 * one instance's state into the page would re-render the whole page and
 * change effect timing — a behaviour change sold as markup editing. Those
 * keep refusing `uses-hooks`.
 *
 * The shape a movable hook must have, all of it checked:
 *   - a top-level `const` of the component's body, initialised by the call;
 *   - bound to one name, or destructured one level with plain names
 *     (`const { t, lang: language } = useLanguage()`) — no defaults, no rest;
 *   - arguments that are literals, or (for `useContext`) a context the
 *     component's module scope names — never a prop or a body value.
 *
 * Where it goes (decided lazily, only for the hooks the markup reads):
 *   - the enclosing component already makes the SAME call (same hook
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
 *
 * Plans only. `detachComponent.ts` writes, and its gate checks that every
 * moved binding binds, at the markup's new position, to the enclosing
 * component's own top-level scope.
 */
import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
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

/** A hook call in the component's body that may be moved — see this module's doc for the shape. */
export interface ComponentHook {
  statement: VariableStatement
  call: CallExpression
  /** What the user reads in a confirm: `useLanguage`. */
  label: string
  binding: { kind: 'whole'; decl: Node; local: string } | { kind: 'keys'; keys: HookKey[] }
  /** The declaration the callee resolves to — two calls are the same hook when these match. */
  identity: unknown
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

/**
 * Every hook call in `fn`'s body, each one checked movable — or a
 * `uses-hooks` refusal naming the first that is not.
 */
export function readComponentHooks(fn: FunctionLike, componentName: string): ComponentHook[] {
  const hooks: ComponentHook[] = []
  const body = fn.getBody()
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeName(call)
    if (!name || !HOOK_CALL_RE.test(name)) continue
    const identity = contextReaderIdentity(call)
    if (identity === undefined) {
      fail(
        'uses-hooks',
        `${componentName} uses ${name} — detach moves only a hook that reads a context (like useLanguage()); state and effects stay with a component. Duplicate the component and edit the copy instead.`,
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
    for (const arg of call.getArguments()) {
      const outerName = Node.isIdentifier(arg) && !isWithin(resolvedDeclaration(arg.getSymbol()) ?? fn, fn)
      if (!isLiteralArgument(arg) && !(identity === 'react:useContext' && outerName)) {
        fail('uses-hooks', `${componentName} passes ${name} a value its own props or body compute, which the enclosing component does not have.`)
      }
    }
    hooks.push({ statement, call, label: name, binding: readHookBinding(decl.getNameNode(), componentName, name), identity })
  }
  return hooks
}

function readHookBinding(nameNode: Node, componentName: string, hookName: string): ComponentHook['binding'] {
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
  let holder = fn.getParent()
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

  private readonly byDecl = new Map<Node, { hook: ComponentHook; key?: string }>()
  private readonly placed = new Map<ComponentHook, (key: string | undefined) => PageRead>()
  private readonly component: FunctionLike | undefined
  private pageCalls: PageHookCall[] | undefined
  private takenNames: Set<string> | undefined
  private concise: { newStatements: string[] } | undefined

  constructor(
    hooks: readonly ComponentHook[],
    private readonly page: SourceFile,
    private readonly callSite: Node,
    private readonly names: DetachNameResolver,
    private readonly componentName: string,
  ) {
    for (const hook of hooks) {
      if (hook.binding.kind === 'whole') this.byDecl.set(hook.binding.decl, { hook })
      else for (const key of hook.binding.keys) this.byDecl.set(key.decl, { hook, key: key.key })
    }
    this.component = enclosingFunctionComponent(callSite)
  }

  /** The start of the enclosing component — the gate finds it again by this after the page is rewritten. */
  get componentStart(): number | undefined {
    return this.component?.getStart()
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
    const existing = this.findPageCall(component, hook)
    if (existing) {
      const reuse = this.reuse(hook, existing)
      if (reuse) return reuse
    }
    return this.writeNewCall(component, hook)
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
    const args = hook.call.getArguments().map((arg) => (Node.isIdentifier(arg) ? this.outer(arg) : arg.getText()))
    const locals = new Map<string | undefined, string>()
    let pattern: string
    if (hook.binding.kind === 'whole') {
      const local = this.freshName(hook.binding.local)
      locals.set(undefined, local)
      pattern = local
    } else {
      const parts: string[] = []
      for (const key of hook.binding.keys) {
        const local = this.freshName(key.local)
        locals.set(key.key, local)
        parts.push(local === key.key ? local : `${keyText(key.key)}: ${local}`)
      }
      pattern = `{ ${parts.join(', ')} }`
    }
    const statement = `const ${pattern} = ${calleeText}(${args.join(', ')})`
    this.movedHooks.push(hook.label)
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

function keyText(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}
