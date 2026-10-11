/**
 * exposeLiteralSites — the parts of "Expose as prop" that read ONE component's
 * source and know nothing about which call site is being edited: finding the
 * literal an override names (an element's whole text, an attribute, one inline
 * style value), the prop name a free variant of it can take, the shape of a
 * call-site attribute, and the lookups both orchestrators share
 * (`exposeLiteralAsProp` for an instance on the page, `exposeThroughLevels`
 * for one inside another component).
 *
 * A binding is never baked: every reader here answers `not-a-literal` for
 * anything that is not a plain string/number/boolean literal.
 */
import * as path from 'node:path'
import { Node, SyntaxKind, type Project, type SourceFile } from 'ts-morph'
import type { FunctionLike } from '@core/page-parser'
import { findComponentCallSites } from './componentCallSites'
import { jsStringLiteral, jsxTextValue, isJsxAttributeSafe } from './detachSource'
import { findJsxElementAtLocationOrThrow, loadSourceFile, type JsxOpeningLikeElement } from './locateJsxElement'

export type ExposeTarget = { kind: 'text' } | { kind: 'attribute'; name: string } | { kind: 'style'; property: string }

export type ExposeLiteralRefusalReason =
  | 'unresolvable'
  | 'package-component'
  | 'not-in-component'
  | 'not-a-literal'
  | 'unsupported-params'
  | 'unsupported-props-type'
  | 'maps-over-props'
  | 'call-site-spread'
  | 'shared-prop'

/** One literal of the element, the prop it becomes, and (optionally) this call site's own value for it. */
export interface ExposeOverride {
  target: ExposeTarget
  /** The preferred prop name — a free variant is chosen when it is taken. */
  propName: string
  /** Written at THIS call site when given; otherwise every call site, this one included, renders the default. */
  value?: string | number | boolean
}

/** A JSX call site: absolute file and its tag-name `line:col`. */
export interface CallSiteLocation {
  file: string
  line: number
  col: number
}

export interface ExposeLiteralAsPropParams {
  /** The call site on the PAGE: absolute file and its tag-name `line:col`. */
  callSiteFile: string
  callSiteLine: number
  callSiteCol: number
  /**
   * G-2b — when the element sits in a component that is itself rendered by
   * another component, the call sites inside those components, outermost
   * first: the first is where the page's component renders the next one, and
   * so on down to the one that renders the component holding the element.
   * Each is a position the caller decoded and contained from the element's own
   * id. Absent for an element one call site deep.
   */
  via?: readonly CallSiteLocation[]
  /** The element inside the component's markup: absolute file and its tag-name `line:col`. */
  elementFile: string
  line: number
  col: number
  workspaceRoot: string
  /** The literals of that one element to expose — each target at most once. */
  overrides: readonly ExposeOverride[]
  project?: Project
}

export type ExposeLiteralAsPropResult =
  /** `propNames` — the name each override was given, in `overrides` order. */
  | { ok: true; propNames: string[]; callSites: number }
  | { ok: false; refusal: { reason: ExposeLiteralRefusalReason; message: string } }

export const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/
export const RESERVED_PROPS = new Set(['children', 'key', 'ref', 'class', 'for', 'style', 'className'])
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i

export class ExposeRefusal extends Error {
  readonly reason: ExposeLiteralRefusalReason
  constructor(reason: ExposeLiteralRefusalReason, message: string) {
    super(message)
    this.reason = reason
  }
}

export function refuse(reason: ExposeLiteralRefusalReason, message: string): never {
  throw new ExposeRefusal(reason, message)
}


/** One literal, and what replaces it once it is a prop. */
export interface LiteralSite {
  /** The range the prop reference replaces, in the component file's full text. */
  start: number
  end: number
  /** How the prop is read there: `{name}` in JSX, `name` in an expression. */
  asJsx: boolean
  /** The default, as JS source. */
  defaultText: string
  type: 'string' | 'number' | 'boolean'
  /** A node inside the literal's position, for the `.map`-over-props check. */
  anchor: Node
}

function literalExpression(expr: Node): { text: string; type: LiteralSite['type'] } | undefined {
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return { text: jsStringLiteral(expr.getLiteralValue()), type: 'string' }
  }
  if (Node.isNumericLiteral(expr)) return { text: expr.getText(), type: 'number' }
  if (Node.isTrueLiteral(expr) || Node.isFalseLiteral(expr)) return { text: expr.getText(), type: 'boolean' }
  return undefined
}

function textLiteral(opening: JsxOpeningLikeElement, file: SourceFile): LiteralSite {
  const element = Node.isJsxOpeningElement(opening) ? opening.getParent() : undefined
  if (!element || !Node.isJsxElement(element)) refuse('not-a-literal', 'This element has no text to expose. Select an element that has text.')
  const children = element.getJsxChildren().filter((child) => {
    if (Node.isJsxText(child)) return !child.containsOnlyTriviaWhiteSpaces()
    return !(Node.isJsxExpression(child) && child.getExpression() === undefined)
  })
  const only = children.length === 1 ? children[0]! : undefined
  if (only && Node.isJsxText(only)) {
    const raw = file.getFullText().slice(only.getPos(), only.getEnd())
    const lead = raw.length - raw.trimStart().length
    const span = raw.trim()
    if (HTML_ENTITY_RE.test(span)) refuse('not-a-literal', 'This text contains an HTML entity, which means something different in a prop value. Replace the entity with the character.')
    const start = only.getPos() + lead
    return { start, end: start + span.length, asJsx: true, defaultText: jsStringLiteral(jsxTextValue(span)), type: 'string', anchor: only }
  }
  const expr = only && Node.isJsxExpression(only) ? only.getExpression() : undefined
  const literal = expr ? literalExpression(expr) : undefined
  if (!expr || !literal || literal.type !== 'string') {
    refuse('not-a-literal', 'Only an element whose whole content is one piece of literal text can expose it as a prop. Select such an element.')
  }
  return { start: expr.getStart(), end: expr.getEnd(), asJsx: false, defaultText: literal.text, type: 'string', anchor: expr }
}

function attributeLiteral(opening: JsxOpeningLikeElement, name: string): LiteralSite {
  const attribute = opening.getAttributes().find((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === name)
  const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
  if (initializer && Node.isStringLiteral(initializer)) {
    const value = initializer.getLiteralText()
    if (value.includes('&')) refuse('not-a-literal', `The ${name} value contains an HTML entity, which means something different in a prop value. Replace the entity with the character.`)
    return { start: initializer.getStart(), end: initializer.getEnd(), asJsx: true, defaultText: jsStringLiteral(value), type: 'string', anchor: initializer }
  }
  const expr = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
  const literal = expr ? literalExpression(expr) : undefined
  if (!expr || !literal) refuse('not-a-literal', `\`${name}\` is not a literal on this element, since it already reads a value. Edit the value in the code.`)
  return { start: expr.getStart(), end: expr.getEnd(), asJsx: false, defaultText: literal.text, type: literal.type, anchor: expr }
}

function styleLiteral(opening: JsxOpeningLikeElement, property: string): LiteralSite {
  const attribute = opening.getAttributes().find((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === 'style')
  const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
  const object = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
  if (!object || !Node.isObjectLiteralExpression(object)) refuse('not-a-literal', 'This element has no inline style object to expose a value from. Select an element that has one.')
  for (const member of object.getProperties()) {
    if (!Node.isPropertyAssignment(member)) continue
    const key = member.getNameNode()
    const keyText = Node.isIdentifier(key) ? key.getText() : Node.isStringLiteral(key) ? key.getLiteralValue() : undefined
    if (keyText !== property) continue
    const value = member.getInitializer()
    const literal = value ? literalExpression(value) : undefined
    if (!value || !literal || literal.type === 'boolean') break
    return { start: value.getStart(), end: value.getEnd(), asJsx: false, defaultText: literal.text, type: literal.type, anchor: value }
  }
  refuse('not-a-literal', `\`${property}\` is not a literal value in this element's inline style. Edit it in the code.`)
}

function rootIdentifier(expr: Node): string | undefined {
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr) || Node.isElementAccessExpression(expr)) return rootIdentifier(expr.getExpression())
  return undefined
}

/** The literal sits inside a `.map` over one of the component's own props: a default would stand in for data. */
export function assertNotMappedOverProps(anchor: Node, fn: FunctionLike, propNames: ReadonlySet<string>): void {
  for (const ancestor of anchor.getAncestors()) {
    if (ancestor === fn) return
    if (!Node.isCallExpression(ancestor)) continue
    const callee = ancestor.getExpression()
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'map') continue
    const root = rootIdentifier(callee.getExpression())
    if (root && propNames.has(root)) refuse('maps-over-props', 'This literal is rendered once per item of a list the component is handed, so one prop cannot override it. Edit it in the code.')
  }
}

/** The component is typed through its VARIABLE (`const Card: FC<Props> = …`): a binding added to an untyped parameter would not type-check. */
export function isTypedThroughVariable(fn: FunctionLike): boolean {
  let holder: Node | undefined = fn.getParent()
  while (holder && (Node.isParenthesizedExpression(holder) || Node.isCallExpression(holder) || Node.isAsExpression(holder))) holder = holder.getParent()
  return holder !== undefined && Node.isVariableDeclaration(holder) && holder.getTypeNode() !== undefined
}

/** The name the component's file exports it under, or `undefined` for a private, same-file component. */
export function exportNameOf(componentFile: SourceFile, declaration: Node): string | undefined {
  for (const [name, declarations] of componentFile.getExportedDeclarations()) {
    if (declarations.some((decl) => decl === declaration || decl.getStart() === declaration.getStart())) return name
  }
  return undefined
}

/** Every call site of the component: imports anywhere in the workspace, plus uses in its own file. */
export function allCallSites(project: Project, workspaceRoot: string, componentFile: SourceFile, localName: string | undefined, exportName: string | undefined): JsxOpeningLikeElement[] {
  const openings: JsxOpeningLikeElement[] = []
  if (exportName) {
    for (const site of findComponentCallSites(project, workspaceRoot, componentFile.getFilePath(), exportName)) {
      const abs = path.join(workspaceRoot, ...site.file.split('/'))
      if (path.relative(abs, componentFile.getFilePath()) === '') continue
      openings.push(findJsxElementAtLocationOrThrow(loadSourceFile(project, abs), abs, site.line, site.col))
    }
  }
  if (localName) {
    for (const kind of [SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement] as const) {
      for (const opening of componentFile.getDescendantsOfKind(kind)) {
        if (opening.getTagNameNode().getText() === localName) openings.push(opening)
      }
    }
  }
  return openings
}

/** Every function-like of `file`, in document order — what a component is found among again after a splice forgot every node. */
export function functionLikesOf(file: SourceFile): FunctionLike[] {
  return file.getDescendants().filter((node): node is FunctionLike => Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node))
}

/** The component, found again by its place among the file's functions: neither a splice nor a signature edit above it adds or removes one. */
export function functionAtIndex(file: SourceFile, index: number): FunctionLike {
  const found = functionLikesOf(file)[index]
  if (!found) throw new Error('[exposeLiteralAsProp] the component could not be found again after its literal was replaced.')
  return found
}

export function attributeText(name: string, value: string | number | boolean): string {
  if (value === true) return name
  if (typeof value === 'string') return isJsxAttributeSafe(value) ? `${name}="${value}"` : `${name}={${jsStringLiteral(value)}}`
  return `${name}={${String(value)}}`
}

/** The type a prop is declared with: the literal's own, widened when this call site hands a value of another type (`padding: 8` overridden with `'12px'`). */
export function propType(literal: LiteralSite, value: ExposeOverride['value']): string {
  return value === undefined || typeof value === literal.type ? literal.type : `${literal.type} | ${typeof value}`
}

export function targetKey(target: ExposeTarget): string {
  return target.kind === 'text' ? 'text' : target.kind === 'attribute' ? `attribute:${target.name}` : `style:${target.property}`
}

export function literalFor(element: JsxOpeningLikeElement, componentFile: SourceFile, target: ExposeTarget): LiteralSite {
  return target.kind === 'text' ? textLiteral(element, componentFile) : target.kind === 'attribute' ? attributeLiteral(element, target.name) : styleLiteral(element, target.property)
}
