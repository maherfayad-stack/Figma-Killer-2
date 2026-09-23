/**
 * detachSource — what `detachComponent.ts` READS before it decides anything:
 * the component's destructured signature (by declaration, so a renamed or
 * nested binding is known for what it is), the call site's attributes,
 * spreads, key and children, and the `Value` a reference becomes at the call
 * site, with the spelling rules (JSX text, attribute strings, parentheses)
 * that keep a substituted value meaning exactly what it meant. Pure reads —
 * nothing here writes.
 */
import { Node, SyntaxKind, type BindingElement, type JsxAttribute } from 'ts-morph'
import type { FunctionLike } from '@core/page-parser'
import type { JsxOpeningLikeElement } from './locateJsxElement'

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

/** Thrown from anywhere inside planning or the gate; `detachComponentInstance` turns it into a `DetachFailure`. Never escapes `detachComponentInstance`. */
export class DetachRefusalSignal extends Error {
  readonly reason: DetachRefusalReason
  constructor(reason: DetachRefusalReason, message: string) {
    super(message)
    this.reason = reason
  }
}

export function fail(reason: DetachRefusalReason, message: string): never {
  throw new DetachRefusalSignal(reason, message)
}


// ---------------------------------------------------------------------------
// The component's signature, read by declaration
// ---------------------------------------------------------------------------

export interface ParamEntry {
  /** The prop this binding reads; `undefined` for a computed key (`[k]: v`), which no call site can be matched against. */
  attrName: string | undefined
  default?: Node
}

export interface ParamTable {
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

export function readParamTable(fn: FunctionLike): ParamTable {
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

export interface CallSiteAttr {
  name: string
  attr: JsxAttribute
  index: number
}

export interface CallSite {
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

export function readCallSite(opening: JsxOpeningLikeElement): CallSite {
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

export interface Value {
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

export const NO_NAMES: ReadonlySet<string> = new Set()
export const UNDEFINED_VALUE: Value = { expr: () => 'undefined', primary: true, free: NO_NAMES, isUndefined: true }
export const TRUE_VALUE: Value = { expr: () => 'true', primary: true, free: NO_NAMES, isTrue: true }

export const INTRINSIC_TAG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
export const TAG_CHAIN_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i

export function isPrimary(node: Node): boolean {
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

export function isJsxNode(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node)
}

/** A value that can never be `undefined` at runtime — so a destructured default can never apply to it. */
export function isNeverUndefined(node: Node): boolean {
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
export function jsStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`
}

/** A string that can sit between two JSX tags as text and mean exactly itself. */
export function isJsxTextSafe(value: string, allowEntities: boolean): boolean {
  if (value === '' || value !== value.trim()) return false
  if (/[{}<>\r\n]/.test(value)) return false
  return allowEntities || !value.includes('&')
}

/** A JS string value that can be written as a JSX attribute string and mean exactly itself (JSX decodes entities, and has no escapes). */
export function isJsxAttributeSafe(value: string): boolean {
  return !/["&\r\n]/.test(value)
}

/**
 * What a run of JSX TEXT evaluates to, as React receives it: lines trimmed
 * except at the outer edges, blank lines dropped, joined with one space — the
 * whitespace rule every JSX compiler applies (entities are left as written).
 */
export function jsxTextValue(text: string): string {
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
export function jsxStringValue(raw: string, attrText: string | undefined, free: ReadonlySet<string>, quote = "'"): Value {
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
export function needsParens(site: Node, value: Value): boolean {
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

export function isWithin(node: Node, container: Node): boolean {
  return node.getSourceFile() === container.getSourceFile() && node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd()
}

export function isImportBinding(node: Node): boolean {
  return Node.isImportSpecifier(node) || Node.isImportClause(node) || Node.isNamespaceImport(node)
}

export function isTopLevelDeclaration(node: Node): boolean {
  if (Node.isVariableDeclaration(node)) return Node.isSourceFile(node.getVariableStatement()?.getParent())
  return Node.isSourceFile(node.getParent())
}

