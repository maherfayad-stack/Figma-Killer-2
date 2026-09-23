/**
 * detachComponent — WS-4.4, the Figma "detach instance" verb for a LOCAL
 * `studio.instance`. Replaces a component call site (`<Card title="Confirm"
 * onClose={onClose}/>`) with Card's OWN returned JSX, substituted with the
 * call site's argument EXPRESSIONS (source text, never evaluated values —
 * `title={plan.name}` stays a binding), so the page's source ends up exactly
 * as if the author had hand-written Card's markup at that position. After
 * detach, `<Card/>` no longer exists there: the parser will not produce a
 * `studio.instance` node at that location on the next load, and every node
 * detach materialized belongs to the page file, editable without the
 * "changes every instance" warning `fromComponent` used to carry (owner
 * decision OD-9: it still renders, its props no longer apply, and the user
 * can edit anything freely).
 *
 * SYMBOLS, NOT SPELLINGS
 * ----------------------
 * Every identifier in the chosen JSX is resolved with the TypeScript checker
 * in the COMPONENT's file — which declaration it names, not what it is
 * called — and then placed so it names the same thing in the PAGE:
 *
 *  - a destructured PARAM, in ANY expression position (`cn(styles.card,
 *    className)`, `featured && …`, `` `/p/${id}` ``, `{ width: size }`,
 *    `title.toUpperCase()`), becomes the call site's own expression — or the
 *    destructured default, or `undefined` when the call site omitted it,
 *    because that is exactly what an omitted prop IS. An attribute whose whole
 *    value becomes `undefined` is dropped; a string in child position becomes
 *    JSX text (`Confirm`, not `{"Confirm"}`); a string attribute is written
 *    `className="neutral"`, not `className={'neutral'}`;
 *  - a call-site SPREAD (`<Card {...plan}/>`) supplies `plan.title` for every
 *    param no explicit attribute after it sets; the component's own `...rest`
 *    is written out as the call site's leftover attributes (DET-2);
 *  - a body `const` read once by the JSX is inlined as its initializer;
 *  - a name from the component's MODULE scope is imported into the page —
 *    reusing an equivalent import, else under its own name, else ALIASED
 *    (`styles` → `cardStyles`) when the page already means something else by
 *    it — and the rename is exact because it is keyed on the symbol;
 *  - a global stays a global, and must not be shadowed where the text lands.
 *
 * FAILS CLOSED, and says WHY (`DetachRefusal`) rather than guessing. Every
 * refusal leaves both files byte-identical — the plan is built and checked
 * before the first byte changes, and the post-build gate below restores the
 * page's in-memory text before returning. Nothing is saved on any refusal.
 *
 *  - `package-component` / `unresolvable` / `not-a-component` — the call
 *    target is not a local component with a readable declaration.
 *  - `uses-hooks` — a hook needs a component to mount in.
 *  - `maps-over-props` — the JSX `.map`s over one of its own props: inlining
 *    one static copy would drop that data-drivenness.
 *  - `unsupported-params` — an undestructured `props`, a nested destructure,
 *    a prop used somewhere its call-site value cannot be written (a JSX tag
 *    name that is not a component name, a type position).
 *  - `spread-ambiguous` — which value a prop has cannot be known from source:
 *    an explicit attribute BEFORE a spread, two spreads, a spread of a
 *    non-identifier, or a call-site spread into a component that forwards
 *    `...rest`.
 *  - `body-local` — the JSX reads a body value that cannot be inlined (read
 *    more than once, read inside a callback, or computed from other body
 *    state).
 *  - `unbound-reference` — something the JSX needs cannot be bound in the
 *    page (a private module-level helper of the component's file, a name from
 *    the scope around the component), or the post-build gate found a name it
 *    cannot account for.
 *  - `name-collision` — a name would bind to something different in the page
 *    and cannot be aliased: a global the page shadows, a same-file name a
 *    local shadows at the call site, or a call-site expression that one of the
 *    component's own inner bindings would capture.
 *
 * THE GATE. After the plan is written into the page (in memory),
 * `subtreeFreeVariables.ts` re-reads the inserted markup and checks every
 * free name against what the plan promised: a call-site name must bind
 * exactly as it did at the call site, an imported one must bind at module
 * scope, a global must stay unbound. Anything else refuses and restores.
 *
 * A component with more than one JSX-bearing `return` (parser-06) is not
 * refused: `getReturnedJsxRoots` picks the same one the canvas shows, and
 * `DetachSuccess.branchNote` says so.
 */
import {
  Node,
  Project,
  QuoteKind,
  SymbolFlags,
  SyntaxKind,
  VariableDeclarationKind,
  type BindingElement,
  type Identifier,
  type JsxAttribute,
  type JsxAttributeLike,
  type SourceFile,
  type Symbol as MorphSymbol,
  type TypeChecker,
  type VariableDeclaration,
} from 'ts-morph'
import { findJsxElementAtLocationOrThrow, loadSourceFile, type JsxOpeningLikeElement } from './locateJsxElement'
import { createWorkspaceProject, getReturnedJsxRoots, type FunctionLike } from '@core/page-parser'
import { resolveComponentCallSite } from './resolveComponentCallSite'
import {
  applyImportBinding,
  importRequestForBinding,
  importRequestForExport,
  mirrorSideEffectImports,
  planImportBinding,
  removeImportIfLastUsage,
  topLevelBindingNames,
  type ImportRequest,
} from './importReconcile'
import {
  analyzeFreeVariables,
  bindingKindAt,
  freeReferenceNames,
  freeVariablesOutOfScopeAt,
  isReferenceIdentifier,
  tagReferenceRoot,
  type BindingKind,
} from './subtreeFreeVariables'
import { introducesSyntaxErrors } from './reinsertJsxSource'

export interface DetachComponentParams {
  /** Absolute path to the page file holding the call site. */
  file: string
  line: number
  col: number
  /** Absolute path to the workspace root — needed to classify the call target as local vs package. */
  workspaceRoot: string
  /** Optional pre-existing project to reuse (e.g. across multiple edits, or shared with the caller's own project). */
  project?: Project
}

export type DetachRefusalReason =
  | 'not-a-component'
  | 'package-component'
  | 'unresolvable'
  | 'uses-hooks'
  | 'maps-over-props'
  | 'unsupported-params'
  | 'no-renderable-jsx'
  | 'spread-ambiguous'
  | 'body-local'
  | 'unbound-reference'
  | 'name-collision'

export interface DetachRefusal {
  reason: DetachRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export interface DetachSuccess {
  ok: true
  /** Set when the component had more than one JSX-bearing return/branch — which one got inlined. */
  branchNote?: string
}

export interface DetachFailure {
  ok: false
  refusal: DetachRefusal
}

export type DetachResult = DetachSuccess | DetachFailure

const HOOK_CALL_RE = /^use[A-Z0-9]/

function refuse(reason: DetachRefusalReason, message: string): DetachFailure {
  return { ok: false, refusal: { reason, message } }
}

/** Thrown from anywhere inside planning or the gate; `detachComponentInstance` turns it into a `DetachFailure`. Never escapes this module. */
class DetachRefusalSignal extends Error {
  readonly reason: DetachRefusalReason
  constructor(reason: DetachRefusalReason, message: string) {
    super(message)
    this.reason = reason
  }
}

function fail(reason: DetachRefusalReason, message: string): never {
  throw new DetachRefusalSignal(reason, message)
}

/** True if `fn`'s body calls anything shaped like a hook, anywhere (including inside a nested callback — a hook cannot legally be called there either, but the point here is just "this body is not a pure markup function"). */
function usesHooks(fn: FunctionLike): string | undefined {
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    const name = Node.isIdentifier(expr)
      ? expr.getText()
      : Node.isPropertyAccessExpression(expr)
        ? expr.getName()
        : undefined
    if (name && HOOK_CALL_RE.test(name)) return name
  }
  return undefined
}

/** Root identifier of a (possibly chained) member/element access — `items` for `items.map`, `props.items` for `props.items.map`. */
function rootIdentifier(expr: Node): string | undefined {
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr)) return rootIdentifier(expr.getExpression())
  if (Node.isElementAccessExpression(expr)) return rootIdentifier(expr.getExpression())
  return undefined
}

/** True when `root`'s JSX contains a `.map(...)` call whose receiver traces back to one of the component's OWN prop names. */
function mapsOverAnyProp(root: Node, propNames: ReadonlySet<string>): boolean {
  for (const call of root.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== 'map') continue
    const id = rootIdentifier(expr.getExpression())
    if (id && propNames.has(id)) return true
  }
  return false
}

export interface ParamBinding {
  /** The call site's own attribute name this param forwards, e.g. `{ title }` -> `'title'`; `{ title: t }` -> attrName `'title'`, paramName `'t'`. */
  attrName: string
  /** Verbatim source text of a literal/simple default (`= 'Confirm'`), when the destructure declares one. */
  defaultText?: string
}

/**
 * Reads a component's destructured first-parameter pattern into a
 * name-keyed map, and separately names the `children` binding. The
 * "what props does this component's signature accept" read that
 * `swapComponentInstance` (prop diff) and `addSlotPropToComponent` share. A
 * `...rest` element and a nested pattern are not props this map can name, so
 * they are skipped here; detach reads them itself, by symbol
 * (`readParamTable`).
 */
export function buildParamBindings(fn: FunctionLike): { childrenParam?: string; params: Map<string, ParamBinding>; hasUndestructuredParam: boolean } {
  const params = new Map<string, ParamBinding>()
  let childrenParam: string | undefined
  const first = fn.getParameters()[0]
  if (!first) return { childrenParam, params, hasUndestructuredParam: false }

  const pattern = first.getNameNode()
  if (!Node.isObjectBindingPattern(pattern)) {
    return { childrenParam, params, hasUndestructuredParam: true }
  }

  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken()) continue
    const nameNode = element.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue
    const paramName = nameNode.getText()
    const propertyNameNode = element.getPropertyNameNode()
    const attrName = propertyNameNode ? propertyNameNode.getText() : paramName
    if (attrName === 'children') {
      childrenParam = paramName
      continue
    }
    const initializer = element.getInitializer()
    params.set(paramName, { attrName, defaultText: initializer?.getText() })
  }
  return { childrenParam, params, hasUndestructuredParam: false }
}

// ---------------------------------------------------------------------------
// The component's signature, read by declaration
// ---------------------------------------------------------------------------

interface ParamEntry {
  /** The prop this binding reads; `undefined` for a computed key (`[k]: v`), which no call site can be matched against. */
  attrName: string | undefined
  default?: Node
}

interface ParamTable {
  entries: Map<Node, ParamEntry>
  rest?: BindingElement
  /** Bindings inside a NESTED pattern (`{ a: { b } }`) — nothing to substitute them with. */
  nested: Set<Node>
  /** Every prop name a named binding consumes — the complement is what `...rest` receives. */
  consumed: Set<string>
}

function propertyNameText(node: Node): string | undefined {
  if (Node.isIdentifier(node) || Node.isNumericLiteral(node)) return node.getText()
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue()
  return undefined
}

function readParamTable(fn: FunctionLike): ParamTable {
  const table: ParamTable = { entries: new Map(), nested: new Set(), consumed: new Set() }
  const pattern = fn.getParameters()[0]?.getNameNode()
  if (!pattern || !Node.isObjectBindingPattern(pattern)) return table
  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken()) {
      table.rest = element
      continue
    }
    const nameNode = element.getNameNode()
    const propertyNameNode = element.getPropertyNameNode()
    const attrName = propertyNameNode ? propertyNameText(propertyNameNode) : nameNode.getText()
    if (attrName !== undefined) table.consumed.add(attrName)
    if (!Node.isIdentifier(nameNode)) {
      for (const inner of nameNode.getDescendantsOfKind(SyntaxKind.BindingElement)) table.nested.add(inner)
      continue
    }
    table.entries.set(element, { attrName, default: element.getInitializer() })
  }
  return table
}

// ---------------------------------------------------------------------------
// The call site
// ---------------------------------------------------------------------------

interface CallSiteAttr {
  name: string
  attr: JsxAttribute
  index: number
}

interface CallSite {
  /** The whole call-site element: the self-closing element, or the open/close pair. */
  site: Node
  attrs: CallSiteAttr[]
  spreads: { expr: Node; index: number }[]
  key?: JsxAttribute
  /** The element children, when there are any that render (whitespace and `{/* … *\/}` do not). */
  children?: { nodes: Node[]; rawText: string }
}

/**
 * The call site's children as JSX source, with the edge whitespace JSX itself
 * ignores (a whitespace run that contains a newline) removed — so
 * `<Shell>\n  <p/>\n</Shell>` splices `<p/>`, while `<b> hi </b>`'s spaces,
 * which render, survive.
 */
function trimJsxEdgeWhitespace(text: string): string {
  const leading = /^\s*/.exec(text)![0]
  const trailing = /\s*$/.exec(text)![0]
  let out = text
  if (trailing.includes('\n') && trailing.length < out.length) out = out.slice(0, out.length - trailing.length)
  if (leading.includes('\n')) out = out.slice(leading.length)
  return out
}

function readCallSite(opening: JsxOpeningLikeElement): CallSite {
  const attrs: CallSiteAttr[] = []
  const spreads: CallSite['spreads'] = []
  let key: JsxAttribute | undefined
  opening.getAttributes().forEach((attribute, index) => {
    if (Node.isJsxSpreadAttribute(attribute)) {
      spreads.push({ expr: attribute.getExpression(), index })
      return
    }
    const name = attribute.getNameNode().getText()
    if (name === 'key') key = attribute
    else attrs.push({ name, attr: attribute, index })
  })

  // A self-closing element (`<Card/>`) HAS no children and IS the whole call
  // site — `.getParent()` on it returns whatever CONTAINS it, NOT "this
  // element's own open+close pair". Only a `JsxOpeningElement`'s parent is
  // the JsxElement this call site is. Conflating the two once read a SIBLING
  // element's children as the call site's own.
  if (Node.isJsxSelfClosingElement(opening)) return { site: opening, attrs, spreads, key }
  const element = opening.getParentOrThrow()
  if (!Node.isJsxElement(element)) return { site: opening, attrs, spreads, key }
  const nodes = element.getJsxChildren().filter((child) => {
    if (Node.isJsxText(child)) return !child.containsOnlyTriviaWhiteSpaces()
    if (Node.isJsxExpression(child)) return child.getExpression() !== undefined
    return true
  })
  if (nodes.length === 0) return { site: element, attrs, spreads, key }
  const fullText = opening.getSourceFile().getFullText()
  const rawText = trimJsxEdgeWhitespace(fullText.slice(opening.getEnd(), element.getClosingElement().getStart()))
  return { site: element, attrs, spreads, key, children: { nodes, rawText } }
}

// ---------------------------------------------------------------------------
// Values — what a reference becomes at the call site
// ---------------------------------------------------------------------------

interface Value {
  /** The value as a JS expression. May refuse: a JSX attribute string carrying an HTML entity has no faithful JS spelling. */
  expr(): string
  primary: boolean
  /** Names the value's text reads from its surroundings — what a binding inside the component could capture. */
  free: ReadonlySet<string>
  isUndefined?: boolean
  isTrue?: boolean
  numeric?: boolean
  /** A call-site `attr="…"` string, verbatim: raw text (entities and all) plus a JSX attribute spelling when one is safe. */
  jsxString?: { raw: string; attrText?: string }
  /** A JS string literal's value. */
  jsString?: string
  jsx?: boolean
  /** Spelled as a JSX tag: a component reference chain (`Card`, `icons.Home`) or an intrinsic element name (`section`). */
  tagChain?: string
  intrinsicTag?: string
}

const NO_NAMES: ReadonlySet<string> = new Set()
const UNDEFINED_VALUE: Value = { expr: () => 'undefined', primary: true, free: NO_NAMES, isUndefined: true }
const TRUE_VALUE: Value = { expr: () => 'true', primary: true, free: NO_NAMES, isTrue: true }

const INTRINSIC_TAG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const TAG_CHAIN_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i

function isPrimary(node: Node): boolean {
  return (
    Node.isIdentifier(node) ||
    Node.isPropertyAccessExpression(node) ||
    Node.isElementAccessExpression(node) ||
    Node.isCallExpression(node) ||
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isTemplateExpression(node) ||
    Node.isTaggedTemplateExpression(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNullLiteral(node) ||
    Node.isThisExpression(node) ||
    Node.isArrayLiteralExpression(node) ||
    Node.isParenthesizedExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isRegularExpressionLiteral(node) ||
    isJsxNode(node)
  )
}

function isJsxNode(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node)
}

/** A value that can never be `undefined` at runtime — so a destructured default can never apply to it. */
function isNeverUndefined(node: Node): boolean {
  return (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isTemplateExpression(node) ||
    Node.isNumericLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNullLiteral(node) ||
    Node.isObjectLiteralExpression(node) ||
    Node.isArrayLiteralExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isRegularExpressionLiteral(node) ||
    Node.isNewExpression(node) ||
    isJsxNode(node)
  )
}

/** `value` as a single-quoted JS string literal. */
function jsStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`
}

/** A string that can sit between two JSX tags as text and mean exactly itself. */
function isJsxTextSafe(value: string, allowEntities: boolean): boolean {
  if (value === '' || value !== value.trim()) return false
  if (/[{}<>\r\n]/.test(value)) return false
  return allowEntities || !value.includes('&')
}

/** A JS string value that can be written as a JSX attribute string and mean exactly itself (JSX decodes entities, and has no escapes). */
function isJsxAttributeSafe(value: string): boolean {
  return !/["&\r\n]/.test(value)
}

/**
 * What a run of JSX TEXT evaluates to, as React receives it: lines trimmed
 * except at the outer edges, blank lines dropped, joined with one space — the
 * whitespace rule every JSX compiler applies (entities are left as written).
 */
function jsxTextValue(text: string): string {
  const lines = text.split(/\r\n|\n|\r/)
  const kept: string[] = []
  lines.forEach((line, index) => {
    let piece = line
    if (index > 0) piece = piece.replace(/^\s+/, '')
    if (index < lines.length - 1) piece = piece.replace(/\s+$/, '')
    if (piece !== '') kept.push(piece)
  })
  return kept.join(' ')
}

/** A `Value` for text written in JSX-string form (an attribute string, or a text child): entities decode the same way in both. */
function jsxStringValue(raw: string, attrText: string | undefined, free: ReadonlySet<string>, quote = "'"): Value {
  return {
    expr: () => {
      if (HTML_ENTITY_RE.test(raw)) {
        fail(
          'unsupported-params',
          `A prop value "${raw}" contains an HTML entity, which means something different once it is moved into a JavaScript expression.`,
        )
      }
      return /[\\\r\n]/.test(raw) || raw.includes(quote) ? jsStringLiteral(raw) : `${quote}${raw}${quote}`
    },
    primary: true,
    free,
    jsxString: { raw, attrText },
    intrinsicTag: INTRINSIC_TAG_RE.test(raw) ? raw : undefined,
  }
}

/** Whether `site` needs parentheses around a non-primary value — only where the grammar would otherwise re-associate it. */
function needsParens(site: Node, value: Value): boolean {
  const parent = site.getParent()
  if (!parent) return !value.primary
  if (value.numeric && Node.isPropertyAccessExpression(parent) && parent.getExpression() === site) return true
  if (value.primary) return false
  if (
    Node.isJsxExpression(parent) ||
    Node.isParenthesizedExpression(parent) ||
    Node.isArrayLiteralExpression(parent) ||
    Node.isTemplateSpan(parent) ||
    Node.isSpreadElement(parent) ||
    Node.isSpreadAssignment(parent) ||
    Node.isJsxSpreadAttribute(parent) ||
    Node.isReturnStatement(parent) ||
    (Node.isVariableDeclaration(parent) && parent.getInitializer() === site) ||
    (Node.isPropertyAssignment(parent) && parent.getInitializer() === site) ||
    ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && (parent.getArguments() as Node[]).includes(site))
  ) {
    return false
  }
  return true
}

function isWithin(node: Node, container: Node): boolean {
  return node.getSourceFile() === container.getSourceFile() && node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd()
}

function isImportBinding(node: Node): boolean {
  return Node.isImportSpecifier(node) || Node.isImportClause(node) || Node.isNamespaceImport(node)
}

function isTopLevelDeclaration(node: Node): boolean {
  if (Node.isVariableDeclaration(node)) return Node.isSourceFile(node.getVariableStatement()?.getParent())
  return Node.isSourceFile(node.getParent())
}

/** Every value this module's output reads, and how it must bind in the page. */
type Expectation = 'call-site' | 'module' | 'global'

type Ref =
  | { kind: 'internal' }
  | { kind: 'param'; entry: ParamEntry }
  | { kind: 'rest' }
  | { kind: 'local'; decl: VariableDeclaration }
  | { kind: 'outer'; symbol: MorphSymbol | undefined; decl: Node | undefined }

/** One piece of the component's source being rewritten: the chosen JSX root, or a default/initializer inlined into it. */
interface Unit {
  node: Node
  /** Names the rendered text reads from outside itself. */
  free: Set<string>
}

interface PendingImport {
  request: ImportRequest
  local: string
}

interface DetachPlan {
  siteText: string
  imports: PendingImport[]
  expected: Map<string, Set<Expectation>>
  callSiteKinds: Map<string, BindingKind>
}

// ---------------------------------------------------------------------------
// The planner — reads, decides, refuses; never writes
// ---------------------------------------------------------------------------

class DetachPlanner {
  private readonly checker: TypeChecker
  private readonly text: string
  private readonly params: ParamTable
  private readonly callSite: CallSite
  private readonly callSiteScope = new Map<string, MorphSymbol>()
  private readonly pageTopLevel: Set<string>
  private readonly pageFreeNames: Set<string>
  private readonly fnIdentifierNames: Set<string>
  private readonly reserved = new Set<string>()
  private readonly imports: PendingImport[] = []
  private readonly expected = new Map<string, Set<Expectation>>()
  private readonly outerNames = new Map<unknown, string>()
  private readonly refCache = new Map<Node, Ref>()
  private readonly paramCache = new Map<ParamEntry, Value>()
  private readonly inProgress = new Set<Node>()
  private readonly scopeCache = new Map<Node, Map<string, MorphSymbol>>()
  private fragmentLocal: string | undefined
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
    const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias
    for (const symbol of this.checker.getSymbolsInScope(opening, meaning)) {
      if (!this.callSiteScope.has(symbol.getName())) this.callSiteScope.set(symbol.getName(), symbol)
    }
    this.pageTopLevel = topLevelBindingNames(page)
    this.pageFreeNames = new Set(freeReferenceNames(page))
    this.fnIdentifierNames = new Set(fn.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()))
  }

  plan(): DetachPlan {
    const rootUnit: Unit = { node: this.root, free: new Set() }
    const key = this.callSite.key
    if (key) {
      const keyExpr = key.getInitializer()
      if (keyExpr) this.expectCallSiteNames(new Set(freeReferenceNames(keyExpr)))
      // A fragment root can only carry a key as `<Fragment key>`.
      if (Node.isJsxFragment(this.root) || !isJsxNode(this.root)) this.fragmentLocal = this.fragmentBinding()
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
    for (const [name, kinds] of this.expected) {
      if (kinds.has('call-site')) callSiteKinds.set(name, bindingKindAt(this.callSite.site, name, this.page))
    }
    return { siteText: text, imports: this.imports, expected: this.expected, callSiteKinds }
  }

  // --- bookkeeping ---------------------------------------------------------

  private expect(name: string, kind: Expectation): void {
    let kinds = this.expected.get(name)
    if (!kinds) this.expected.set(name, (kinds = new Set()))
    kinds.add(kind)
  }

  private expectCallSiteNames(names: ReadonlySet<string>): void {
    for (const name of names) this.expect(name, 'call-site')
  }

  private callSiteValue(node: Node): Value {
    const free = new Set(freeReferenceNames(node))
    this.expectCallSiteNames(free)
    const isString = Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)
    const literal = isString ? node.getLiteralValue() : undefined
    const text = node.getText()
    const isChain = (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) && TAG_CHAIN_RE.test(text)
    return {
      expr: () => text,
      primary: isPrimary(node),
      free,
      numeric: Node.isNumericLiteral(node),
      jsString: literal,
      jsx: isJsxNode(node),
      tagChain: isChain ? text : undefined,
      intrinsicTag: literal !== undefined && INTRINSIC_TAG_RE.test(literal) ? literal : undefined,
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
      const name = this.outerName(id, ref)
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
    throw new Error('[detachComponent] siteValueFor called for a non-substitutable reference')
  }

  /** The value a substitutable reference at `expr` takes (a param, a body local, `rest.x`), or `undefined` when `expr` is not one. */
  private siteValue(expr: Node, unit: Unit): Value | undefined {
    if (Node.isIdentifier(expr) && isReferenceIdentifier(expr)) {
      const ref = this.classify(expr, unit)
      if (ref.kind === 'param' || ref.kind === 'local') return this.siteValueFor(expr, ref, unit)
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
    if (Node.isIdentifier(expr) && this.callSite.children && isReferenceIdentifier(expr)) {
      const ref = this.classify(expr, unit)
      if (ref.kind === 'param' && ref.entry.attrName === 'children') {
        const free = new Set(this.callSite.children.nodes.flatMap((child) => freeReferenceNames(child)))
        this.expectCallSiteNames(free)
        this.admit(expr, free, unit)
        return this.callSite.children.rawText
      }
    }
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
      const value = inner ? this.siteValue(inner, unit) : undefined
      if (!value || !inner) {
        items.push({ name, text: this.renderNode(property, unit), separator })
        return
      }
      this.admit(inner, value.free, unit)
      const text = this.attributeText(name, value)
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

  /** How `name` is written with `value`, or `undefined` to drop it (an absent prop renders no attribute). */
  private attributeText(name: string, value: Value): string | undefined {
    if (value.isUndefined) return undefined
    if (value.isTrue) return name
    if (value.jsxString?.attrText) return `${name}=${value.jsxString.attrText}`
    if (value.jsString !== undefined && isJsxAttributeSafe(value.jsString)) return `${name}="${value.jsString}"`
    return `${name}={${value.expr()}}`
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
      rendered = this.outerName(rootId, ref)
      unit.free.add(rendered)
    } else if (ref.kind === 'rest') {
      fail('spread-ambiguous', `${this.componentName} renders a tag out of its \`...${rootName}\`, which detach can't resolve.`)
    } else if (ref.kind === 'local') {
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
    if (entry.attrName === 'children' && this.callSite.children) return this.childrenValue()
    return this.attributeValue(entry.attrName, entry.default)
  }

  private lastAttribute(name: string): CallSiteAttr | undefined {
    return this.callSite.attrs.filter((a) => a.name === name).at(-1)
  }

  private attributeValue(name: string, fallback: Node | undefined): Value {
    const explicit = this.lastAttribute(name)
    const spreads = this.callSite.spreads
    const lastSpread = spreads.at(-1)
    if (lastSpread && (!explicit || explicit.index < lastSpread.index)) {
      if (explicit) {
        fail(
          'spread-ambiguous',
          `This call site sets \`${name}\` and then spreads {...${lastSpread.expr.getText()}}, which may or may not override it — which value renders can't be known from source.`,
        )
      }
      if (spreads.length > 1) {
        fail('spread-ambiguous', `This call site spreads ${spreads.length} objects, and \`${name}\` could come from any of them.`)
      }
      if (!Node.isIdentifier(lastSpread.expr)) {
        fail('spread-ambiguous', `This call site spreads {...${lastSpread.expr.getText()}}, which detach can't read a prop out of — spread a named object instead.`)
      }
      const base = lastSpread.expr.getText()
      const text = /^[A-Za-z_$][\w$]*$/.test(name) ? `${base}.${name}` : `${base}[${jsStringLiteral(name)}]`
      const free = new Set([base])
      this.expectCallSiteNames(free)
      const member: Value = { expr: () => text, primary: true, free }
      return fallback ? this.defaulted(member, fallback) : member
    }
    if (explicit) return this.explicitValue(explicit.attr, fallback)
    return fallback ? this.componentValue(fallback) : UNDEFINED_VALUE
  }

  private explicitValue(attr: JsxAttribute, fallback: Node | undefined): Value {
    const initializer = attr.getInitializer()
    if (!initializer) return TRUE_VALUE
    if (Node.isStringLiteral(initializer)) {
      const text = initializer.getText()
      return jsxStringValue(initializer.getLiteralText(), text, NO_NAMES, text.charAt(0))
    }
    if (Node.isJsxExpression(initializer)) {
      const expr = initializer.getExpression()
      if (!expr || (Node.isIdentifier(expr) && expr.getText() === 'undefined')) {
        return fallback ? this.componentValue(fallback) : UNDEFINED_VALUE
      }
      const value = this.callSiteValue(expr)
      return fallback && !isNeverUndefined(expr) ? this.defaulted(value, fallback) : value
    }
    return this.callSiteValue(initializer)
  }

  /** A destructured default applies exactly when the value is `undefined` — so that is what gets written. */
  private defaulted(value: Value, fallback: Node): Value {
    const alternative = this.componentValue(fallback)
    const operand = value.primary ? value.expr() : `(${value.expr()})`
    return {
      expr: () => `${operand} === undefined ? ${alternative.expr()} : ${value.expr()}`,
      primary: false,
      free: new Set([...value.free, ...alternative.free]),
    }
  }

  /** `children` as a VALUE (anywhere but a `{children}` child slot): one element, one expression, or one run of text. */
  private childrenValue(): Value {
    const nodes = this.callSite.children!.nodes
    const only = nodes.length === 1 ? nodes[0]! : undefined
    if (only && isJsxNode(only)) return this.callSiteValue(only)
    if (only && Node.isJsxExpression(only) && only.getExpression()) return this.callSiteValue(only.getExpression()!)
    if (only && Node.isJsxText(only)) {
      const raw = jsxTextValue(only.getText())
      const attrText = raw.includes('"') ? (raw.includes("'") ? undefined : `'${raw}'`) : `"${raw}"`
      return jsxStringValue(raw, /[\r\n]/.test(raw) ? undefined : attrText, NO_NAMES)
    }
    fail('unsupported-params', `${this.componentName} uses its children as a value, and this call site passes more than one child.`)
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
    const literal = Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? node.getLiteralValue() : undefined
    return {
      expr: () => text,
      primary: isPrimary(node),
      free: unit.free,
      numeric: Node.isNumericLiteral(node),
      jsString: literal,
      jsx: isJsxNode(node),
      tagChain: (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) && TAG_CHAIN_RE.test(text) ? text : undefined,
      intrinsicTag: literal !== undefined && INTRINSIC_TAG_RE.test(literal) ? literal : undefined,
    }
  }

  /** A body `const` the JSX reads: inlined as its initializer when that is a faithful rewrite, refused otherwise. */
  private localValue(decl: VariableDeclaration, site: Node, unit: Unit): Value {
    const name = decl.getName()
    if (unit.node !== this.root) {
      const owner = unit.node.getParent()
      const what = Node.isVariableDeclaration(owner) ? `\`${owner.getName()}\`` : 'a prop default'
      fail(
        'body-local',
        `${this.componentName} computes ${what} from \`${name}\`, another value in its body — detach inlines one level only. Duplicate the component and edit the copy instead.`,
      )
    }
    const uses = this.root
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .filter((id) => isReferenceIdentifier(id) && this.symbolOf(id)?.getDeclarations().includes(decl))
    if (uses.length !== 1) {
      fail(
        'body-local',
        `${this.componentName} computes \`${name}\` in its body and its markup reads it ${uses.length} times — inlining would repeat the computation. Duplicate the component and edit the copy instead.`,
      )
    }
    for (const ancestor of site.getAncestors()) {
      if (ancestor === this.root) break
      if (Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor)) {
        fail(
          'body-local',
          `${this.componentName} computes \`${name}\` once per render but reads it inside a callback — inlined, it would be recomputed on every call. Duplicate the component and edit the copy instead.`,
        )
      }
    }
    return this.componentValue(decl.getInitializerOrThrow())
  }

  /** `rest.x` — the call site's own `x`, unless a named param consumed it. */
  private restMemberValue(node: Node, unit: Unit): Value | undefined {
    if (!Node.isPropertyAccessExpression(node)) return undefined
    const object = node.getExpression()
    if (!Node.isIdentifier(object) || !isReferenceIdentifier(object) || this.classify(object, unit).kind !== 'rest') return undefined
    this.assertRestIsReadable()
    const name = node.getName()
    if (this.params.consumed.has(name) || name === 'key') return UNDEFINED_VALUE
    if (name === 'children' && this.callSite.children) return this.childrenValue()
    const explicit = this.lastAttribute(name)
    return explicit ? this.explicitValue(explicit.attr, undefined) : UNDEFINED_VALUE
  }

  private assertRestIsReadable(): void {
    const spread = this.callSite.spreads[0]
    if (spread) {
      fail(
        'spread-ambiguous',
        `This call site spreads {...${spread.expr.getText()}} into ${this.componentName}, which forwards \`...rest\` — which props land where can't be known from source.`,
      )
    }
    if (this.callSite.children && !this.params.consumed.has('children')) {
      fail('spread-ambiguous', `This call site passes children, and ${this.componentName} forwards them through \`...rest\` rather than placing them.`)
    }
  }

  /** The call site's attributes a `{...rest}` receives: every one no named param consumed, in call-site order. */
  private restLeftovers(): { name: string; text: string; free: ReadonlySet<string> }[] {
    this.assertRestIsReadable()
    const out: { name: string; text: string; free: ReadonlySet<string> }[] = []
    for (const attr of this.callSite.attrs) {
      if (this.params.consumed.has(attr.name) || this.lastAttribute(attr.name) !== attr) continue
      const initializer = attr.attr.getInitializer()
      const free = new Set(initializer ? freeReferenceNames(initializer) : [])
      this.expectCallSiteNames(free)
      out.push({ name: attr.name, text: attr.attr.getText(), free })
    }
    return out
  }

  // --- names from the component's module scope -----------------------------

  private canonical(symbol: MorphSymbol): unknown {
    return this.checker.getExportSymbolOfSymbol(symbol).compilerSymbol
  }

  private declaredInPage(symbol: MorphSymbol | undefined): boolean {
    return symbol?.getDeclarations().some((d) => d.getSourceFile() === this.page) ?? false
  }

  /** The name a module-scope or global reference is written as in the page — planning the import it needs. */
  private outerName(id: Node, ref: Extract<Ref, { kind: 'outer' }>): string {
    const name = id.getText()
    const cacheKey = ref.symbol ? this.canonical(ref.symbol) : `?${name}`
    const cached = this.outerNames.get(cacheKey)
    if (cached !== undefined) return cached
    const resolved = this.resolveOuterName(name, ref)
    this.outerNames.set(cacheKey, resolved)
    return resolved
  }

  private resolveOuterName(name: string, ref: Extract<Ref, { kind: 'outer' }>): string {
    const atCallSite = this.callSiteScope.get(name)
    const decl = ref.decl
    const isGlobal = !decl || decl.getSourceFile() !== this.componentFile
    if (ref.symbol && atCallSite && this.canonical(atCallSite) === this.canonical(ref.symbol)) {
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

  /** Whether a NEW top-level import may be named `local` without changing what anything else in the page — or in the markup — means. */
  private isNameAvailable(local: string, originalName: string): boolean {
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
  private fragmentBinding(): string {
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

// ---------------------------------------------------------------------------
// The post-build gate
// ---------------------------------------------------------------------------

/**
 * Re-reads the markup as it now sits in the page and checks every free name
 * against the plan. A planning bug that left a component-scope name behind
 * (the pre-DET-1 codemod's whole failure class) is caught here as an
 * `unbound-reference`/`name-collision` instead of being written.
 */
function gateInsertedMarkup(inserted: Node, page: SourceFile, plan: DetachPlan): void {
  for (const variable of analyzeFreeVariables(inserted, page)) {
    const { name } = variable
    const kinds = plan.expected.get(name)
    const now = bindingKindAt(inserted, name, page)
    if (!kinds) {
      fail(
        now === 'none' ? 'unbound-reference' : 'name-collision',
        now === 'none'
          ? `The detached markup would read \`${name}\`, which nothing in the page declares.`
          : `The detached markup would read \`${name}\`, and in the page that name means something else.`,
      )
    }
    if (kinds.has('call-site') && now !== plan.callSiteKinds.get(name)) {
      fail('name-collision', `The call site's \`${name}\` would bind to something else once the markup is inlined.`)
    }
    if (kinds.has('module') && now !== 'module') {
      fail(
        now === 'none' ? 'unbound-reference' : 'name-collision',
        `The detached markup's \`${name}\` would not bind to the import it needs at that position in the page.`,
      )
    }
    if (kinds.has('global') && now !== 'none') {
      fail('name-collision', `The detached markup reads the global \`${name}\`, which the page shadows at that position.`)
    }
  }
  for (const name of freeVariablesOutOfScopeAt(inserted, inserted, page)) {
    const kinds = plan.expected.get(name)
    const unboundBefore = kinds?.has('call-site') && plan.callSiteKinds.get(name) === 'none'
    if (!kinds?.has('global') && !unboundBefore) {
      fail('unbound-reference', `The detached markup would read \`${name}\`, which nothing in the page declares.`)
    }
  }
}

/**
 * Detaches the LOCAL component call site at (file, line, col): writes its
 * own returned JSX at the call site, substituted with the call site's own
 * argument expressions, reconciles imports, and returns `{ok:true}` (the
 * client should reload — a write here always shifts line numbers). Refuses,
 * with a specific reason and with the file untouched, when the target isn't
 * faithfully inlinable — see this module's header.
 */
export function detachComponentInstance(params: DetachComponentParams): DetachResult {
  const { file, line, col, workspaceRoot } = params
  // Unlike this module's siblings (`setJsxProp`, …), this codemod needs
  // CROSS-FILE resolution — the target component's own declaring file, and
  // the checker's view of both files' scopes — so it needs a workspace-wide
  // `Project`, not a single-file `createProject()`.
  const project = params.project ?? createWorkspaceProject(workspaceRoot)
  // New import declarations follow ts-morph's quote-kind setting, not the
  // file's existing style. Default to single quotes (this codebase's own
  // dominant convention); a project that prefers double quotes gets a
  // one-line mismatch a formatter fixes.
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const sourceFile = loadSourceFile(project, file)

  const opening = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const fullTagName = opening.getTagNameNode().getText()
  const identifier = fullTagName.split('.')[0]!
  if (!/^[A-Z]/.test(fullTagName)) {
    return refuse('not-a-component', `<${fullTagName}> is a plain HTML element, not a component instance.`)
  }

  const resolved = resolveComponentCallSite(project, sourceFile, workspaceRoot, identifier, file, line, col)
  if (!resolved.ok) {
    if (resolved.failure.reason === 'package-component') {
      return refuse(
        'package-component',
        `${resolved.failure.message} Detaching a package component uses a different action ` +
          '("Eject to local component" / "Replace with markup snapshot"), not yet available.',
      )
    }
    return refuse('unresolvable', resolved.failure.message)
  }
  const { target, fn } = resolved.result

  const hook = usesHooks(fn)
  if (hook) {
    return refuse('uses-hooks', `${identifier} uses ${hook} — detach can't inline a component that uses hooks.`)
  }

  const { childrenParam, params: paramBindings, hasUndestructuredParam } = buildParamBindings(fn)
  if (hasUndestructuredParam) {
    return refuse(
      'unsupported-params',
      `${identifier} takes an undestructured props parameter — detach can't rewrite bare props.x references.`,
    )
  }

  const roots = getReturnedJsxRoots(fn)
  const chosen = roots.find((r) => r.chosen)
  if (!chosen) {
    return refuse('no-renderable-jsx', `${identifier} has no renderable JSX to inline.`)
  }
  const hadAlternatives = roots.some((r) => !r.chosen)

  const restName = readParamTable(fn).rest?.getName()
  const propNames = new Set([...paramBindings.keys(), ...(childrenParam ? [childrenParam] : []), ...(restName ? [restName] : [])])
  if (mapsOverAnyProp(chosen.expr, propNames)) {
    return refuse(
      'maps-over-props',
      `${identifier} maps over one of its own props to render — detach can't inline data-driven content.`,
    )
  }

  const original = sourceFile.getFullText()
  try {
    const plan = new DetachPlanner(project, sourceFile, target.sourceFile, fn, chosen.expr, opening, identifier).plan()
    // Everything below writes the page IN MEMORY only; any refusal restores
    // `original` and nothing reaches the disk.
    const site = Node.isJsxSelfClosingElement(opening) ? opening : opening.getParentOrThrow()
    for (const pending of plan.imports) applyImportBinding(sourceFile, pending.request, pending.local)
    if (target.sourceFile !== sourceFile) mirrorSideEffectImports(sourceFile, target.sourceFile)
    const inserted = site.replaceWithText(plan.siteText)
    gateInsertedMarkup(inserted, sourceFile, plan)
    // Only now — after the call site's own tag reference is actually gone
    // from the tree — is "does anything else in the file still reference
    // Card" decidable.
    removeImportIfLastUsage(sourceFile, identifier)
    if (introducesSyntaxErrors(file, original, sourceFile.getFullText())) {
      throw new Error(`[detachComponent] the detached source for <${identifier}> does not parse — nothing was written.`)
    }
  } catch (err) {
    if (sourceFile.getFullText() !== original) sourceFile.replaceWithText(original)
    if (err instanceof DetachRefusalSignal) return refuse(err.reason, err.message)
    throw err
  }

  sourceFile.saveSync()

  return {
    ok: true,
    ...(hadAlternatives
      ? { branchNote: `${identifier} has more than one rendered state — the currently-shown one was inlined.` }
      : {}),
  }
}
