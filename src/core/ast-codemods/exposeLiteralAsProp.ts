/**
 * exposeLiteralAsProp — P5-C (DET-7): "Expose as prop", React's own form of a
 * Figma instance override.
 *
 * An element inside a component's markup renders the SAME literal at every
 * call site — `<h2>Current text</h2>` in `Card.tsx`. Editing it there changes
 * every `<Card/>` (the "changes every instance" warning), and detaching this
 * one instance gives up the component. This is the honest middle: the
 * literal becomes an OPTIONAL prop whose DEFAULT is that same literal,
 *
 *     export function Card({ title, heading = 'Current text' }) {
 *       return <h2>{heading}</h2>
 *
 * so every call site that does not pass `heading` renders byte-for-byte what
 * it rendered before, and — only when the caller hands a `value` — this ONE
 * call site passes the new one (`<Card heading="New text" />`). Two files,
 * one gesture, zero blast radius; ⌘Z is the undo journal's `restore`.
 *
 * One call may expose SEVERAL literals of the one element (a gesture that sets
 * `width` and `height` together): they are located against the original text,
 * written in one splice per file, and given their signatures in order, so the
 * whole gesture is one write and one undo-journal entry.
 *
 * What can be exposed (`ExposeTarget`), each only when it is a LITERAL in the
 * component's own source — a binding is never baked:
 *   - `text`: an element whose whole content is one run of text (or one
 *     string in braces) — only the text is replaced, the whitespace around it
 *     stays, so it renders exactly as before;
 *   - `attribute`: `title="x"`, `{'x'}`, `{12}`, `{true}`;
 *   - `style`: one property of an inline `style={{ … }}` object.
 *
 * Refuses, with every file byte-identical:
 *   - `unresolvable` / `package-component` — the call site is not a local
 *     component (the same resolution detach uses);
 *   - `not-in-component` — the element is not in that component's own markup;
 *   - `not-a-literal` — the target is not a literal there (a binding, an
 *     entity, several children);
 *   - `unsupported-params` — an undestructured `props`;
 *   - `unsupported-props-type` — the props type is not a same-file object
 *     shape, or is given through the component's variable (`FC<Props>`);
 *   - `maps-over-props` — the literal is inside a `.map` over one of the
 *     component's own props;
 *   - `call-site-spread` — some call site spreads an object into the
 *     component, which could already carry a key of the new name.
 *
 * The prop's name is the caller's, or the first `name2`, `name3`… that no
 * identifier in the component, no module-scope name of its file, no existing
 * prop and no attribute at ANY call site already uses — a call site passing a
 * `heading` that `...rest` forwards today would otherwise start setting it.
 */
import * as path from 'node:path'
import { Node, QuoteKind, SyntaxKind, type Project, type SourceFile } from 'ts-morph'
import { createWorkspaceProject, type FunctionLike } from '@core/page-parser'
import { buildParamBindings } from './detachComponent'
import { findComponentCallSites } from './componentCallSites'
import { addOptionalPropToSignature, widenPropType } from './componentPropSignature'
import { fedIdentifier, needsWidening, planFedOverride, type FedPlan } from './exposeFedProp'
import { jsStringLiteral, jsxTextValue, isJsxAttributeSafe } from './detachSource'
import { topLevelBindingNames } from './importReconcile'
import { findJsxElementAtLocationOrThrow, loadSourceFile, type JsxOpeningLikeElement } from './locateJsxElement'
import { resolveComponentCallSite } from './resolveComponentCallSite'
import { introducesSyntaxErrors } from './syntaxRegression'

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

export interface ExposeLiteralAsPropParams {
  /** The call site: absolute file and its tag-name `line:col`. */
  callSiteFile: string
  callSiteLine: number
  callSiteCol: number
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

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/
const RESERVED_PROPS = new Set(['children', 'key', 'ref', 'class', 'for', 'style', 'className'])
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i

class ExposeRefusal extends Error {
  readonly reason: ExposeLiteralRefusalReason
  constructor(reason: ExposeLiteralRefusalReason, message: string) {
    super(message)
    this.reason = reason
  }
}

function refuse(reason: ExposeLiteralRefusalReason, message: string): never {
  throw new ExposeRefusal(reason, message)
}

/** One override, planned: a literal that becomes a prop, or a value that already IS a prop (only the call site changes). */
type PlannedOverride = { fed: false; literal: LiteralSite } | { fed: true; plan: Extract<FedPlan, { ok: true }>; name: string }

/** One literal, and what replaces it once it is a prop. */
interface LiteralSite {
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
  if (!element || !Node.isJsxElement(element)) refuse('not-a-literal', 'This element has no text to expose.')
  const children = element.getJsxChildren().filter((child) => {
    if (Node.isJsxText(child)) return !child.containsOnlyTriviaWhiteSpaces()
    return !(Node.isJsxExpression(child) && child.getExpression() === undefined)
  })
  const only = children.length === 1 ? children[0]! : undefined
  if (only && Node.isJsxText(only)) {
    const raw = file.getFullText().slice(only.getPos(), only.getEnd())
    const lead = raw.length - raw.trimStart().length
    const span = raw.trim()
    if (HTML_ENTITY_RE.test(span)) refuse('not-a-literal', 'This text contains an HTML entity, which means something different once it is a prop value.')
    const start = only.getPos() + lead
    return { start, end: start + span.length, asJsx: true, defaultText: jsStringLiteral(jsxTextValue(span)), type: 'string', anchor: only }
  }
  const expr = only && Node.isJsxExpression(only) ? only.getExpression() : undefined
  const literal = expr ? literalExpression(expr) : undefined
  if (!expr || !literal || literal.type !== 'string') {
    refuse('not-a-literal', 'Only an element whose whole content is one piece of literal text can expose it as a prop.')
  }
  return { start: expr.getStart(), end: expr.getEnd(), asJsx: false, defaultText: literal.text, type: 'string', anchor: expr }
}

function attributeLiteral(opening: JsxOpeningLikeElement, name: string): LiteralSite {
  const attribute = opening.getAttributes().find((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === name)
  const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
  if (initializer && Node.isStringLiteral(initializer)) {
    const value = initializer.getLiteralText()
    if (value.includes('&')) refuse('not-a-literal', `The ${name} value contains an HTML entity, which means something different once it is a prop value.`)
    return { start: initializer.getStart(), end: initializer.getEnd(), asJsx: true, defaultText: jsStringLiteral(value), type: 'string', anchor: initializer }
  }
  const expr = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
  const literal = expr ? literalExpression(expr) : undefined
  if (!expr || !literal) refuse('not-a-literal', `\`${name}\` is not a literal on this element — it already reads a value, which stays as it is.`)
  return { start: expr.getStart(), end: expr.getEnd(), asJsx: false, defaultText: literal.text, type: literal.type, anchor: expr }
}

function styleLiteral(opening: JsxOpeningLikeElement, property: string): LiteralSite {
  const attribute = opening.getAttributes().find((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === 'style')
  const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
  const object = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
  if (!object || !Node.isObjectLiteralExpression(object)) refuse('not-a-literal', 'This element has no inline style object to expose a value from.')
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
  refuse('not-a-literal', `\`${property}\` is not a literal value in this element's inline style.`)
}

function rootIdentifier(expr: Node): string | undefined {
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr) || Node.isElementAccessExpression(expr)) return rootIdentifier(expr.getExpression())
  return undefined
}

/** The literal sits inside a `.map` over one of the component's own props: a default would stand in for data. */
function assertNotMappedOverProps(anchor: Node, fn: FunctionLike, propNames: ReadonlySet<string>): void {
  for (const ancestor of anchor.getAncestors()) {
    if (ancestor === fn) return
    if (!Node.isCallExpression(ancestor)) continue
    const callee = ancestor.getExpression()
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'map') continue
    const root = rootIdentifier(callee.getExpression())
    if (root && propNames.has(root)) refuse('maps-over-props', 'This literal is rendered once per item of a list the component is handed, so a single prop cannot override it.')
  }
}

/** The component is typed through its VARIABLE (`const Card: FC<Props> = …`): a binding added to an untyped parameter would not type-check. */
function isTypedThroughVariable(fn: FunctionLike): boolean {
  let holder: Node | undefined = fn.getParent()
  while (holder && (Node.isParenthesizedExpression(holder) || Node.isCallExpression(holder) || Node.isAsExpression(holder))) holder = holder.getParent()
  return holder !== undefined && Node.isVariableDeclaration(holder) && holder.getTypeNode() !== undefined
}

/** The name the component's file exports it under, or `undefined` for a private, same-file component. */
function exportNameOf(componentFile: SourceFile, declaration: Node): string | undefined {
  for (const [name, declarations] of componentFile.getExportedDeclarations()) {
    if (declarations.some((decl) => decl === declaration || decl.getStart() === declaration.getStart())) return name
  }
  return undefined
}

/** Every call site of the component: imports anywhere in the workspace, plus uses in its own file. */
function allCallSites(project: Project, workspaceRoot: string, componentFile: SourceFile, localName: string | undefined, exportName: string | undefined): JsxOpeningLikeElement[] {
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
function functionLikesOf(file: SourceFile): FunctionLike[] {
  return file.getDescendants().filter((node): node is FunctionLike => Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node))
}

/** The component, found again by its place among the file's functions: neither a splice nor a signature edit above it adds or removes one. */
function functionAtIndex(file: SourceFile, index: number): FunctionLike {
  const found = functionLikesOf(file)[index]
  if (!found) throw new Error('[exposeLiteralAsProp] the component could not be found again after its literal was replaced.')
  return found
}

function attributeText(name: string, value: string | number | boolean): string {
  if (value === true) return name
  if (typeof value === 'string') return isJsxAttributeSafe(value) ? `${name}="${value}"` : `${name}={${jsStringLiteral(value)}}`
  return `${name}={${String(value)}}`
}

/** The type a prop is declared with: the literal's own, widened when this call site hands a value of another type (`padding: 8` overridden with `'12px'`). */
function propType(literal: LiteralSite, value: ExposeOverride['value']): string {
  return value === undefined || typeof value === literal.type ? literal.type : `${literal.type} | ${typeof value}`
}

function targetKey(target: ExposeTarget): string {
  return target.kind === 'text' ? 'text' : target.kind === 'attribute' ? `attribute:${target.name}` : `style:${target.property}`
}

function literalFor(element: JsxOpeningLikeElement, componentFile: SourceFile, target: ExposeTarget): LiteralSite {
  return target.kind === 'text' ? textLiteral(element, componentFile) : target.kind === 'attribute' ? attributeLiteral(element, target.name) : styleLiteral(element, target.property)
}

export function exposeLiteralAsProp(params: ExposeLiteralAsPropParams): ExposeLiteralAsPropResult {
  if (params.overrides.length === 0) throw new Error('[exposeLiteralAsProp] nothing to expose.')
  for (const override of params.overrides) {
    if (!IDENTIFIER_RE.test(override.propName)) throw new Error(`[exposeLiteralAsProp] "${override.propName}" is not a valid prop name.`)
  }
  const project = params.project ?? createWorkspaceProject(params.workspaceRoot)
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const callFile = loadSourceFile(project, params.callSiteFile)
  const callSite = findJsxElementAtLocationOrThrow(callFile, params.callSiteFile, params.callSiteLine, params.callSiteCol)
  const identifier = callSite.getTagNameNode().getText().split('.')[0]!

  const resolved = resolveComponentCallSite(project, callFile, params.workspaceRoot, identifier, params.callSiteFile, params.callSiteLine, params.callSiteCol)
  if (!resolved.ok) return { ok: false, refusal: { reason: resolved.failure.reason, message: resolved.failure.message } }
  const { target, fn } = resolved.result
  const componentFile = target.sourceFile
  const originals = new Map([[componentFile, componentFile.getFullText()], [callFile, callFile.getFullText()]])

  try {
    if (path.relative(componentFile.getFilePath(), params.elementFile) !== '') {
      refuse('not-in-component', `That element is not part of <${identifier}>'s own markup.`)
    }
    const element = findJsxElementAtLocationOrThrow(componentFile, params.elementFile, params.line, params.col)
    if (element.getStart() < fn.getStart() || element.getEnd() > fn.getEnd()) {
      refuse('not-in-component', `That element is not part of <${identifier}>'s own markup.`)
    }

    const { params: bindings, childrenParam, hasUndestructuredParam } = buildParamBindings(fn)
    if (hasUndestructuredParam) {
      refuse('unsupported-params', `${identifier} takes an undestructured props parameter — Studio can't add a named prop without rewriting every "props.x".`)
    }
    if (/\.tsx?$/.test(componentFile.getFilePath()) && isTypedThroughVariable(fn) && !fn.getParameters()[0]?.getTypeNode()) {
      refuse('unsupported-props-type', `${identifier}'s props are typed through its variable (like FC<Props>), which Studio can't add a property to safely.`)
    }

    const seenTargets = new Set<string>()
    const propNames = new Set([...bindings.keys(), ...(childrenParam ? [childrenParam] : [])])
    const planned = params.overrides.map((override): PlannedOverride => {
      const key = targetKey(override.target)
      if (seenTargets.has(key)) refuse('not-a-literal', 'The same value was listed twice.')
      seenTargets.add(key)
      // OD-19 — a value that is already the bare read of a prop of this name: only the call site changes.
      const paramName = fedIdentifier(element, override.target)
      const binding = paramName !== undefined ? bindings.get(paramName) : undefined
      if (paramName !== undefined && binding?.attrName === override.propName) {
        if (override.value === undefined) refuse('not-a-literal', `\`${override.propName}\` is already a prop here, so there is no literal to expose.`)
        const plan = planFedOverride({ fn, callSite, paramName, propName: override.propName, defaultText: binding.defaultText, value: override.value })
        if (!plan.ok) refuse(plan.reason, plan.message)
        return { fed: true, plan, name: override.propName }
      }
      const literal = literalFor(element, componentFile, override.target)
      assertNotMappedOverProps(literal.anchor, fn, propNames)
      return { fed: false, literal }
    })
    const literals = planned.flatMap((entry) => (entry.fed ? [] : [entry.literal]))

    // A fed value adds no prop, so no other call site can collide with it: only a new prop needs the survey.
    const sites = literals.length === 0 ? [callSite] : allCallSites(project, params.workspaceRoot, componentFile, target.exportedName ?? identifier, exportNameOf(componentFile, target.declaration))
    if (!sites.some((site) => site === callSite || (site.getSourceFile() === callFile && site.getStart() === callSite.getStart()))) sites.push(callSite)
    const spread = literals.length === 0 ? undefined : sites.find((site) => site.getAttributes().some((attr) => Node.isJsxSpreadAttribute(attr)))
    if (spread) {
      refuse('call-site-spread', `A <${identifier}> in ${path.basename(spread.getSourceFile().getFilePath())} spreads an object into it, which could already set a prop of the new name — nothing was changed.`)
    }

    const taken = new Set<string>([
      ...fn.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()),
      ...topLevelBindingNames(componentFile),
      ...[...bindings.values()].map((binding) => binding.attrName),
      ...sites.flatMap((site) => site.getAttributes().flatMap((attr) => (Node.isJsxAttribute(attr) ? [attr.getNameNode().getText()] : []))),
      ...RESERVED_PROPS,
    ])
    const names = params.overrides.map((override, i) => {
      const entry = planned[i]!
      if (entry.fed) return entry.name
      let name = override.propName
      for (let n = 2; taken.has(name); n += 1) name = `${override.propName}${n}`
      taken.add(name)
      return name
    })

    // Every text edit is one splice of the ORIGINAL texts (the call site and
    // the component may be one file, in either order), then the signature,
    // on the function found again by where the splice moved it.
    const fnIndex = functionLikesOf(componentFile).indexOf(fn)
    const attrs = callSite.getAttributes()
    const attrAt = attrs.length > 0 ? attrs[attrs.length - 1]!.getEnd() : callSite.getTagNameNode().getEnd()
    const attrText = params.overrides.map((override, i) => (override.value === undefined || planned[i]!.fed ? '' : ` ${attributeText(names[i]!, override.value)}`)).join('')
    const edits = new Map<SourceFile, { pos: number; remove: number; text: string }[]>()
    const push = (file: SourceFile, edit: { pos: number; remove: number; text: string }) => edits.set(file, [...(edits.get(file) ?? []), edit])
    planned.forEach((entry, i) => {
      if (entry.fed) push(callFile, entry.plan.edit)
      else push(componentFile, { pos: entry.literal.start, remove: entry.literal.end - entry.literal.start, text: entry.literal.asJsx ? `{${names[i]}}` : names[i]! })
    })
    if (attrText) push(callFile, { pos: attrAt, remove: 0, text: attrText })
    for (const [file, fileEdits] of edits) {
      let out = file.getFullText()
      for (const edit of [...fileEdits].sort((x, y) => y.pos - x.pos)) out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos + edit.remove)
      file.replaceWithText(out)
    }
    for (const [i, entry] of planned.entries()) {
      const component = functionAtIndex(componentFile, fnIndex)
      const name = names[i]!
      const value = params.overrides[i]!.value
      const signature = entry.fed
        ? (() => {
            const widen = value === undefined ? undefined : needsWidening(entry.plan, value)
            return widen === undefined ? { ok: true as const } : widenPropType(componentFile, component, name, widen)
          })()
        : addOptionalPropToSignature(componentFile, component, { name, binding: `${name} = ${entry.literal.defaultText}`, type: propType(entry.literal, value) })
      if (!signature.ok) refuse('unsupported-props-type', signature.message)
    }

    for (const [file, original] of originals) {
      if (introducesSyntaxErrors(file.getFilePath(), original, file.getFullText())) {
        throw new Error(`[exposeLiteralAsProp] ${path.basename(file.getFilePath())} would not parse after exposing \`${names.join('`, `')}\` — nothing was written.`)
      }
    }
    for (const file of originals.keys()) if (file.getFullText() !== originals.get(file)) file.saveSync()
    return { ok: true, propNames: names, callSites: sites.length }
  } catch (err) {
    for (const [file, original] of originals) if (file.getFullText() !== original) file.replaceWithText(original)
    if (err instanceof ExposeRefusal) return { ok: false, refusal: { reason: err.reason, message: err.message } }
    throw err
  }
}
