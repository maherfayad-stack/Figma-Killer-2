/**
 * detachPlanner — the part of detach that turns the component's chosen JSX
 * into page source: every identifier resolved by SYMBOL in the component's
 * file (a param, a body `const`, `...rest`, something inner, or something
 * outer — `detachNames.ts`), then written as the call site's own value,
 * collapsed to JSX text or an attribute string where that means the same
 * thing, parenthesized where the grammar needs it, and refused — never
 * guessed — where no faithful spelling exists. Reads and decides; never
 * writes. See `detachComponent.ts` for the contract.
 */
import {
  Node,
  SymbolFlags,
  SyntaxKind,
  VariableDeclarationKind,
  type Identifier,
  type JsxAttributeLike,
  type Project,
  type SourceFile,
  type Symbol as MorphSymbol,
  type TypeChecker,
  type VariableDeclaration,
} from 'ts-morph'
import type { FunctionLike } from '@core/page-parser'
import type { JsxOpeningLikeElement } from './locateJsxElement'
import { bindingKindAt, freeReferenceNames, isReferenceIdentifier, tagReferenceRoot, type BindingKind } from './subtreeFreeVariables'
import { DetachNameResolver, type Expectation, type PendingImport } from './detachNames'
import { DetachHookPlan, type MovableHook, type PageTextEdit } from './detachHooks'
import { CallSiteValues } from './detachCallSiteValues'
import { ScopeLifts } from './detachScopeLifts'
import { foldClassName, readFoldPart } from './detachClassNameFold'
import { DetachConditionals, type Unit } from './detachConditionals'
import {
  UNDEFINED_VALUE,
  fail,
  attributeText,
  isJsxAttributeSafe,
  nodeValue,
  isJsxNode,
  isJsxTextSafe,
  isWithin,
  needsParens,
  readCallSite,
  readParamTable,
  type CallSite,
  type ParamEntry,
  type ParamTable,
  type Value,
} from './detachSource'

type Ref =
  | { kind: 'internal' }
  | { kind: 'param'; entry: ParamEntry }
  | { kind: 'rest' }
  | { kind: 'local'; decl: VariableDeclaration }
  | { kind: 'hook'; decl: Node }
  | { kind: 'outer'; symbol: MorphSymbol | undefined; decl: Node | undefined }

export interface DetachPlan {
  siteText: string
  imports: PendingImport[]
  expected: Map<string, Set<Expectation>>
  callSiteKinds: Map<string, BindingKind>
  /** DET-3 — edits to the enclosing component (a moved hook call, a key added to a reused pattern), in the page's ORIGINAL coordinates. */
  pageEdits: PageTextEdit[]
  /** DET-3 — hooks a NEW call was written for; what a pre-commit confirm names. */
  movedHooks: string[]
  /** G-3 — the `'use client'` directive the page must start with once component state moved into it. */
  useClient?: string
}

// ---------------------------------------------------------------------------
// The planner — reads, decides, refuses; never writes
// ---------------------------------------------------------------------------

export class DetachPlanner {
  private readonly checker: TypeChecker
  private readonly text: string
  private readonly params: ParamTable
  private readonly callSite: CallSite
  private readonly fnIdentifierNames: Set<string>
  private readonly names: DetachNameResolver
  private readonly hooks: DetachHookPlan
  private readonly values: CallSiteValues
  private readonly refCache = new Map<Node, Ref>()
  private readonly paramCache = new Map<ParamEntry, Value>()
  private readonly inProgress = new Set<Node>()
  private readonly lifts: ScopeLifts
  private readonly scopeCache = new Map<Node, Map<string, MorphSymbol>>()
  private fragmentLocal: string | undefined
  private readonly conditionals: DetachConditionals
  private readonly page: SourceFile
  private readonly componentFile: SourceFile
  private readonly fn: FunctionLike
  private readonly root: Node
  private readonly componentName: string

  constructor(
    project: Project,
    page: SourceFile,
    componentFile: SourceFile,
    fn: FunctionLike,
    root: Node,
    opening: JsxOpeningLikeElement,
    componentName: string,
    hooks: readonly MovableHook[],
  ) {
    this.page = page
    this.componentFile = componentFile
    this.fn = fn
    this.root = root
    this.componentName = componentName
    this.checker = project.getTypeChecker()
    this.text = componentFile.getFullText()
    this.params = readParamTable(fn)
    this.callSite = readCallSite(opening)
    this.fnIdentifierNames = new Set(fn.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()))
    this.names = new DetachNameResolver(this.checker, page, componentFile, componentName, opening, this.fnIdentifierNames)
    this.values = new CallSiteValues(this.callSite, this.names, componentName, (node) => this.componentValue(node))
    this.lifts = new ScopeLifts({
      page,
      componentFile,
      componentName,
      names: this.names,
      renderNode: (node, unit) => this.renderNode(node, unit),
      componentValue: (node) => this.componentValue(node),
      emitLocal: (preferred, initializer) => this.hooks.emitLocal(preferred, initializer),
    })
    this.names.useCarrier((name, decl) => this.lifts.carryDeclaration(name, decl))
    this.hooks = new DetachHookPlan(hooks, page, opening, this.names, componentName, (arg) => this.hookArgument(arg))
    this.conditionals = new DetachConditionals({
      readProp: (reference, unit) => {
        if (Node.isIdentifier(reference)) {
          if (!isReferenceIdentifier(reference)) return undefined
          const ref = this.classify(reference, unit)
          return ref.kind === 'param' ? { literal: this.paramValue(ref.entry).literal } : undefined
        }
        if (!Node.isPropertyAccessExpression(reference)) return undefined
        const value = this.restMemberValue(reference, unit)
        return value ? { literal: value.literal } : undefined
      },
      renderNode: (node, unit) => this.renderNode(node, unit),
      siteValue: (node, unit) => this.siteValue(node, unit),
      admit: (site, names, unit) => this.admit(site, names, unit),
      attributeText,
    })
  }

  plan(): DetachPlan {
    const rootUnit: Unit = { node: this.root, free: new Set() }
    const key = this.callSite.key
    if (key) {
      const keyExpr = key.getInitializer()
      if (keyExpr) this.names.expectCallSiteNames(new Set(freeReferenceNames(keyExpr)))
      // A fragment root can only carry a key as `<Fragment key>`.
      if (Node.isJsxFragment(this.root) || !isJsxNode(this.root)) this.fragmentLocal = this.names.fragmentBinding()
    }
    let text = this.renderNode(this.root, rootUnit)
    if (key && !isJsxNode(this.root)) text = `<${this.fragmentLocal} ${key.getText()}>{${text}}</${this.fragmentLocal}>`

    const siteParent = this.callSite.site.getParentOrThrow()
    const producesJsx = isJsxNode(this.root) || key !== undefined
    if (!producesJsx) {
      if (Node.isJsxElement(siteParent) || Node.isJsxFragment(siteParent) || Node.isJsxAttribute(siteParent)) text = `{${text}}`
      else if (!Node.isJsxExpression(siteParent) && !Node.isParenthesizedExpression(siteParent)) text = `(${text})`
    }

    const callSiteKinds = new Map<string, BindingKind>()
    for (const [name, kinds] of this.names.expected) {
      if (kinds.has('call-site')) callSiteKinds.set(name, bindingKindAt(this.callSite.site, name, this.page))
    }
    this.hooks.finish()
    const { edits: hookEdits, movedHooks, useClient } = this.hooks
    const carriedEdit = this.lifts.carriedDeclarationsEdit()
    const pageEdits = carriedEdit ? [...hookEdits, carriedEdit] : hookEdits
    return {
      siteText: text,
      imports: this.names.imports,
      expected: this.names.expected,
      callSiteKinds,
      pageEdits,
      movedHooks,
      ...(useClient ? { useClient } : {}),
    }
  }

  // --- classification ------------------------------------------------------

  private symbolOf(id: Node): MorphSymbol | undefined {
    const parent = id.getParent()
    if (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === id) return parent.getValueSymbol()
    return id.getSymbol()
  }

  private classify(id: Node, unit: Unit): Ref {
    const cached = this.refCache.get(id)
    if (cached) return cached
    const ref = this.classifyUncached(id, unit)
    this.refCache.set(id, ref)
    return ref
  }

  private classifyUncached(id: Node, unit: Unit): Ref {
    const name = id.getText()
    const symbol = this.symbolOf(id)
    const decl = symbol?.getDeclarations()[0]
    if (!decl || decl.getSourceFile() !== this.componentFile) return { kind: 'outer', symbol, decl }
    if (isWithin(decl, unit.node)) return { kind: 'internal' }
    // The component's own declaration (a recursive `<Tree/>` inside `function
    // Tree`) is module scope, not a body value.
    if (!isWithin(decl, this.fn) || decl === this.fn) return { kind: 'outer', symbol, decl }

    const entry = this.params.entries.get(decl)
    if (entry) return { kind: 'param', entry }
    if (decl === this.params.rest) return { kind: 'rest' }
    if (this.params.nested.has(decl)) {
      fail('unsupported-params', `${this.componentName} reads \`${name}\` out of a nested destructure, which detach can't substitute from the call site.`)
    }
    if (this.hooks.owns(decl)) return { kind: 'hook', decl }
    if (Node.isParameterDeclaration(decl)) {
      fail('unsupported-params', `${this.componentName} reads \`${name}\`, a parameter other than its props, which a call site does not pass.`)
    }
    if (Node.isVariableDeclaration(decl)) {
      const statement = decl.getVariableStatement()
      if (
        statement !== undefined &&
        statement.getParent() === this.fn.getBody() &&
        statement.getDeclarationKind() === VariableDeclarationKind.Const &&
        Node.isIdentifier(decl.getNameNode()) &&
        decl.getInitializer()
      ) {
        return { kind: 'local', decl }
      }
    }
    fail(
      'body-local',
      `${this.componentName}'s markup reads \`${name}\`, which its body computes in a way detach can't inline. Duplicate the component and edit the copy instead.`,
    )
  }

  // --- rendering -----------------------------------------------------------

  /** Text for `[node.getStart(), node.getEnd())`, with every reference rewritten for the page. */
  private renderNode(node: Node, unit: Unit): string {
    if (Node.isIdentifier(node)) return this.renderIdentifier(node, unit)
    if (Node.isPropertyAccessExpression(node)) {
      const value = this.restMemberValue(node, unit)
      if (value) return this.placeExpression(node, value, unit)
    }
    if (Node.isShorthandPropertyAssignment(node)) return this.renderShorthand(node, unit)
    if (Node.isJsxExpression(node) && (Node.isJsxElement(node.getParent()) || Node.isJsxFragment(node.getParent()))) {
      const child = this.renderChildExpression(node, unit)
      if (child !== undefined) return child
    }
    if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node) || Node.isJsxClosingElement(node)) {
      return this.renderTagged(node, unit)
    }
    if (this.fragmentLocal && node.getParent() === this.root) {
      if (Node.isJsxOpeningFragment(node)) return `<${this.fragmentLocal} ${this.callSite.key!.getText()}>`
      if (Node.isJsxClosingFragment(node)) return `</${this.fragmentLocal}>`
    }
    return this.splice(node, (child) => this.renderNode(child, unit))
  }

  private splice(node: Node, renderChild: (child: Node) => string | { start: number; end: number; text: string }): string {
    let out = ''
    let cursor = node.getStart()
    node.forEachChild((child) => {
      const rendered = renderChild(child)
      const piece = typeof rendered === 'string' ? { start: child.getStart(), end: child.getEnd(), text: rendered } : rendered
      const start = Math.max(piece.start, cursor)
      out += this.text.slice(cursor, start) + piece.text
      cursor = Math.max(piece.end, cursor)
    })
    return out + this.text.slice(cursor, node.getEnd())
  }

  private isInTypePosition(id: Node, unit: Unit): boolean {
    for (const ancestor of id.getAncestors()) {
      if (ancestor === unit.node) return false
      if (Node.isTypeNode(ancestor)) return true
    }
    return false
  }

  private renderIdentifier(id: Identifier, unit: Unit): string {
    if (!isReferenceIdentifier(id)) return id.getText()
    const ref = this.classify(id, unit)
    if (ref.kind === 'internal') return id.getText()
    if (ref.kind === 'outer') {
      const name = this.names.outerName(id, ref.symbol, ref.decl)
      unit.free.add(name)
      return name
    }
    if (this.isInTypePosition(id, unit)) {
      fail('unsupported-params', `${this.componentName} uses \`${id.getText()}\` in a type, where a call-site value can't be written.`)
    }
    if (ref.kind === 'rest') {
      fail('spread-ambiguous', `${this.componentName} passes its whole \`...${id.getText()}\` along, which detach can't split into this call site's attributes.`)
    }
    return this.placeExpression(id, this.siteValueFor(id, ref, unit), unit)
  }

  private siteValueFor(site: Node, ref: Ref, unit: Unit): Value {
    if (ref.kind === 'param') return this.paramValue(ref.entry)
    if (ref.kind === 'local') return this.localValue(ref.decl, site, unit)
    if (ref.kind === 'hook') return this.hooks.value(ref.decl)
    throw new Error('[detachComponent] siteValueFor called for a non-substitutable reference')
  }

  /** The value a substitutable reference at `expr` takes (a param, a body local, `rest.x`), or `undefined` when `expr` is not one. */
  private siteValue(expr: Node, unit: Unit): Value | undefined {
    if (Node.isIdentifier(expr) && isReferenceIdentifier(expr)) {
      const ref = this.classify(expr, unit)
      if (ref.kind === 'param' || ref.kind === 'local' || ref.kind === 'hook') return this.siteValueFor(expr, ref, unit)
      if (ref.kind === 'rest') {
        fail('spread-ambiguous', `${this.componentName} passes its whole \`...${expr.getText()}\` along, which detach can't split into this call site's attributes.`)
      }
      return undefined
    }
    if (Node.isPropertyAccessExpression(expr)) return this.restMemberValue(expr, unit)
    return undefined
  }

  private placeExpression(site: Node, value: Value, unit: Unit): string {
    this.admit(site, value.free, unit)
    const text = value.expr()
    return needsParens(site, value) ? `(${text})` : text
  }

  /**
   * Refuses when a binding INSIDE the component's markup (a `.map` row's
   * parameter, say) would capture a name the placed text reads —
   * `title={item.name}` substituted inside `ROWS.map((item) => …)` would read
   * the ROW, not the page's `item`. Otherwise records the names as read.
   */
  private admit(site: Node, names: ReadonlySet<string>, unit: Unit): void {
    for (const name of names) unit.free.add(name)
    const candidates = [...names].filter((name) => this.fnIdentifierNames.has(name))
    if (candidates.length === 0) return
    let scope = this.scopeCache.get(site)
    if (!scope) {
      scope = new Map()
      for (const symbol of this.checker.getSymbolsInScope(site, SymbolFlags.Value | SymbolFlags.Alias)) {
        if (!scope.has(symbol.getName())) scope.set(symbol.getName(), symbol)
      }
      this.scopeCache.set(site, scope)
    }
    for (const name of candidates) {
      const decl = scope.get(name)?.getDeclarations()[0]
      if (decl && isWithin(decl, unit.node)) {
        fail(
          'name-collision',
          `This call site passes a value that reads \`${name}\`, and ${this.componentName}'s own markup declares a \`${name}\` of its own around where that value lands — inlined, it would read the wrong one.`,
        )
      }
    }
  }

  private renderShorthand(node: Node, unit: Unit): string {
    if (!Node.isShorthandPropertyAssignment(node)) return node.getText()
    const id = node.getNameNode()
    const value = this.siteValue(id, unit)
    if (value) {
      this.admit(id, value.free, unit)
      return `${id.getText()}: ${value.expr()}`
    }
    const rendered = this.renderIdentifier(id, unit)
    return rendered === id.getText() ? node.getText() : `${id.getText()}: ${rendered}`
  }

  /** A JSX child `{…}`: collapses a substituted string to JSX text, drops an absent value, and splices call-site children. */
  private renderChildExpression(node: Node, unit: Unit): string | undefined {
    if (!Node.isJsxExpression(node)) return undefined
    const expr = node.getExpression()
    if (!expr || node.getDotDotDotToken()) return undefined
    if (this.callSite.children && this.readsChildren(expr, unit)) {
      const free = new Set(this.callSite.children.nodes.flatMap((child) => freeReferenceNames(child)))
      this.names.expectCallSiteNames(free)
      this.admit(expr, free, unit)
      return this.callSite.children.rawText
    }
    const folded = this.conditionals.child(expr, unit)
    if (folded !== undefined) return folded
    const value = this.siteValue(expr, unit)
    if (!value) return undefined
    this.admit(expr, value.free, unit)
    if (value.isUndefined) return ''
    if (value.jsxString && isJsxTextSafe(value.jsxString.raw, true)) return value.jsxString.raw
    if (value.jsString !== undefined) {
      if (value.jsString === '') return ''
      if (isJsxTextSafe(value.jsString, false)) return value.jsString
    }
    if (value.jsx) return value.expr()
    return `{${value.expr()}}`
  }

  /** `{children}` (a destructured `children` param) or `{props.children}` — the call site's own children, placed as written. */
  private readsChildren(expr: Node, unit: Unit): boolean {
    if (Node.isIdentifier(expr)) {
      if (!isReferenceIdentifier(expr)) return false
      const ref = this.classify(expr, unit)
      return ref.kind === 'param' && ref.entry.attrName === 'children'
    }
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== 'children') return false
    const object = expr.getExpression()
    if (!Node.isIdentifier(object) || !isReferenceIdentifier(object) || this.classify(object, unit).kind !== 'rest') return false
    this.assertRestIsReadable('member')
    return true
  }

  /** An opening, self-closing or closing tag: its name and its attributes rewritten. */
  private renderTagged(node: Node, unit: Unit): string {
    if (!(Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node) || Node.isJsxClosingElement(node))) return node.getText()
    const tag = node.getTagNameNode()
    const isRootOpening =
      (Node.isJsxSelfClosingElement(this.root) && node === this.root) ||
      (Node.isJsxElement(this.root) && node === this.root.getOpeningElement())
    return this.splice(node, (child) => {
      if (child === tag) return this.renderTagName(tag, unit)
      if (child.getKind() !== SyntaxKind.JsxAttributes || Node.isJsxClosingElement(node)) return this.renderNode(child, unit)
      const properties = (node as JsxOpeningLikeElement).getAttributes()
      const attributes = this.renderAttributes(properties, unit, isRootOpening)
      if (properties.length === 0) return { start: child.getPos(), end: child.getPos(), text: attributes ? ` ${attributes}` : '' }
      // Every attribute gone: take the whitespace in front of them too, so
      // `<p title={hint}>` becomes `<p>`, not `<p >`.
      if (!attributes) return { start: child.getPos(), end: child.getEnd(), text: '' }
      return attributes
    })
  }

  private renderAttributes(properties: JsxAttributeLike[], unit: Unit, isRootOpening: boolean): string {
    const items: { name?: string; text: string; separator?: string }[] = []
    const key = isRootOpening ? this.callSite.key : undefined
    if (key) items.push({ name: 'key', text: key.getText() })

    properties.forEach((property, index) => {
      const separator = index === 0 ? undefined : this.text.slice(properties[index - 1]!.getEnd(), property.getStart())
      if (Node.isJsxSpreadAttribute(property)) {
        const expr = property.getExpression()
        if (Node.isIdentifier(expr) && this.classify(expr, unit).kind === 'rest') {
          const leftovers = this.restLeftovers()
          this.admit(expr, new Set(leftovers.flatMap((l) => [...l.free])), unit)
          leftovers.forEach((leftover, i) => items.push({ name: leftover.name, text: leftover.text, separator: i === 0 ? separator : ' ' }))
          return
        }
        items.push({ text: this.renderNode(property, unit), separator })
        return
      }
      const name = property.getNameNode().getText()
      if (key && name === 'key') return // the call site's key is the one React sees
      const initializer = property.getInitializer()
      const inner = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
      const folded = inner && (name === 'className' || name === 'class') ? foldClassName(inner, (part) => readFoldPart(part, () => this.siteValue(part, unit))) : undefined
      if (folded !== undefined && isJsxAttributeSafe(folded)) {
        items.push({ name, text: `${name}="${folded}"`, separator })
        return
      }
      const decided = inner ? this.conditionals.attribute(name, inner, unit) : undefined
      if (decided) {
        if (decided.text !== undefined) items.push({ name, text: decided.text, separator })
        return
      }
      const value = inner ? this.siteValue(inner, unit) : undefined
      if (!value || !inner) {
        items.push({ name, text: this.renderNode(property, unit), separator })
        return
      }
      this.admit(inner, value.free, unit)
      const text = attributeText(name, value)
      if (text !== undefined) items.push({ name, text, separator })
    })

    // Two attributes of one name are a compile error in TSX; the later one
    // is the one that renders (a spread's leftover overriding the
    // component's own `type="button"`, say), so the later one is kept.
    const seen = new Set<string>()
    const kept = items
      .slice()
      .reverse()
      .filter((item) => {
        if (item.name === undefined) return true
        if (seen.has(item.name)) return false
        seen.add(item.name)
        return true
      })
      .reverse()
    return kept.map((item, i) => (i === 0 ? '' : (item.separator ?? ' ')) + item.text).join('')
  }

  private renderTagName(tag: Node, unit: Unit): string {
    const rootName = tagReferenceRoot(tag)
    if (!rootName) return tag.getText()
    const rootId = Node.isIdentifier(tag) ? tag : tag.getFirstDescendant((d) => Node.isIdentifier(d) && d.getText() === rootName)
    if (!rootId || !Node.isIdentifier(rootId)) return tag.getText()
    const isMember = !Node.isIdentifier(tag)
    const ref = this.classify(rootId, unit)
    let rendered: string
    if (ref.kind === 'internal') rendered = rootName
    else if (ref.kind === 'outer') {
      rendered = this.names.outerName(rootId, ref.symbol, ref.decl)
      unit.free.add(rendered)
    } else if (ref.kind === 'rest') {
      fail('spread-ambiguous', `${this.componentName} renders a tag out of its \`...${rootName}\`, which detach can't resolve.`)
    } else if (ref.kind === 'local' || ref.kind === 'hook') {
      fail(
        'body-local',
        `${this.componentName} renders <${tag.getText()}> from \`${rootName}\`, a value its body computes — a tag name can't be written as that expression. Duplicate the component and edit the copy instead.`,
      )
    } else {
      const value = this.siteValueFor(rootId, ref, unit)
      this.admit(rootId, value.free, unit)
      const spelled = isMember ? value.tagChain : (value.tagChain && /^[A-Z]|\./.test(value.tagChain) ? value.tagChain : value.intrinsicTag)
      if (!spelled) {
        fail(
          'unsupported-params',
          `${this.componentName} renders <${rootName}> from a prop, and this call site does not pass something that can be written as a tag name.`,
        )
      }
      rendered = spelled
    }
    return rendered + this.text.slice(rootId.getEnd(), tag.getEnd())
  }

  // --- values --------------------------------------------------------------

  private paramValue(entry: ParamEntry): Value {
    const cached = this.paramCache.get(entry)
    if (cached) return cached
    const value = this.computeParamValue(entry)
    this.paramCache.set(entry, value)
    return value
  }

  private computeParamValue(entry: ParamEntry): Value {
    if (entry.attrName === undefined) {
      fail('unsupported-params', `${this.componentName} destructures a computed prop name, which no call site can be matched against.`)
    }
    // React never passes `key` to a component.
    if (entry.attrName === 'key') return entry.default ? this.componentValue(entry.default) : UNDEFINED_VALUE
    if (entry.attrName === 'children' && this.callSite.children) return this.values.childrenValue()
    return this.values.attributeValue(entry.attrName, entry.default)
  }

  /** The component's own source for a default or a body value, rewritten for the page. */
  private componentValue(node: Node): Value {
    if (this.inProgress.has(node)) {
      fail('unsupported-params', `${this.componentName}'s prop defaults refer to each other in a cycle.`)
    }
    this.inProgress.add(node)
    const unit: Unit = { node, free: new Set() }
    const text = this.renderNode(node, unit)
    this.inProgress.delete(node)
    return nodeValue(node, text, unit.free)
  }

  /**
   * An argument of a hook the plan writes at the top of the enclosing
   * component, in terms of the call site's props (`useDir(dir)` with no `dir`
   * is `useDir(undefined)`). It lands where the call site's own names may not
   * be bound yet, so it can read nothing the call site computes: a literal, an
   * omitted prop, a default, or a module-scope name.
   */
  private hookArgument(arg: Node): string {
    const value = this.componentValue(arg)
    for (const name of value.free) {
      if (this.names.expected.get(name)?.has('call-site')) {
        fail(
          'uses-hooks',
          `${this.componentName} hands a hook a prop, and this call site gives it a value (\`${name}\`) the enclosing component may not have at the top of its body.`,
        )
      }
    }
    return value.expr()
  }

  /**
   * A body `const` the JSX reads. Read once at the top of the markup, it is
   * inlined as its initializer (the cleanest page). Read twice, inside a
   * callback, or built from another body value, it is hoisted instead (G-3):
   * computed once at the top of the page's component, under a fresh name, so
   * nothing is recomputed and nothing is written twice.
   */
  private localValue(decl: VariableDeclaration, site: Node, unit: Unit): Value {
    if (this.canInlineLocal(decl, site, unit)) return this.componentValue(decl.getInitializerOrThrow())
    return this.lifts.hoistLocal(decl)
  }

  private canInlineLocal(decl: VariableDeclaration, site: Node, unit: Unit): boolean {
    if (unit.node !== this.root) return false
    const uses = this.root
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .filter((id) => isReferenceIdentifier(id) && this.symbolOf(id)?.getDeclarations().includes(decl))
    if (uses.length !== 1) return false
    for (const ancestor of site.getAncestors()) {
      if (ancestor === this.root) break
      if (Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor)) return false
    }
    return true
  }

  /** `rest.x` / `props.x` — the call site's own `x`, unless a named param consumed it. */
  private restMemberValue(node: Node, unit: Unit): Value | undefined {
    if (!Node.isPropertyAccessExpression(node)) return undefined
    const object = node.getExpression()
    if (!Node.isIdentifier(object) || !isReferenceIdentifier(object) || this.classify(object, unit).kind !== 'rest') return undefined
    this.assertRestIsReadable('member')
    const name = node.getName()
    if (this.params.restExcludes.has(name) || name === 'key') return UNDEFINED_VALUE
    if (name === 'children' && this.callSite.children) return this.values.childrenValue()
    const explicit = this.values.lastAttribute(name)
    return explicit ? this.values.explicitValue(explicit.attr, undefined) : UNDEFINED_VALUE
  }

  /**
   * Which props `rest` holds can be known only when the call site has no
   * spread. Reading ONE member needs nothing more; forwarding the whole object
   * (`<div {...rest}/>`) also forwards `children`, which the leftover
   * attributes cannot carry — so a call site that passes children refuses there.
   */
  private assertRestIsReadable(use: 'member' | 'forward' = 'forward'): void {
    const spread = this.callSite.spreads[0]
    if (spread) {
      fail(
        'spread-ambiguous',
        `This call site spreads {...${spread.expr.getText()}} into ${this.componentName}, which forwards \`...rest\` — which props land where can't be known from source.`,
      )
    }
    if (use === 'forward' && this.callSite.children && !this.params.restExcludes.has('children')) {
      fail('spread-ambiguous', `This call site passes children, and ${this.componentName} forwards them through \`...rest\` rather than placing them.`)
    }
  }

  /** The call site's attributes a `{...rest}` receives: every one no named param consumed, in call-site order. */
  private restLeftovers(): { name: string; text: string; free: ReadonlySet<string> }[] {
    this.assertRestIsReadable()
    const out: { name: string; text: string; free: ReadonlySet<string> }[] = []
    for (const attr of this.callSite.attrs) {
      if (this.params.restExcludes.has(attr.name) || this.values.lastAttribute(attr.name) !== attr) continue
      const initializer = attr.attr.getInitializer()
      const free = new Set(initializer ? freeReferenceNames(initializer) : [])
      this.names.expectCallSiteNames(free)
      out.push({ name: attr.name, text: attr.attr.getText(), free })
    }
    return out
  }

}
