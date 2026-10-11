/**
 * componentVariantBindings — the VARIANT BINDING ANALYZER (CV-1).
 *
 * Given one local component and one of its enum/boolean props, answers "how
 * does this component's own source turn the prop into styling?" — as data a
 * later writer can act on, never as an action. It classifies the prop's uses
 * into the five patterns real components are written with, and says `opaque`
 * (with the line that defeated it) for everything else:
 *
 *   css-module-class  `styles[variant]`, ``styles[`btn-${variant}`]``, or
 *                     ``className={`btn-${variant}`}`` against a stylesheet
 *   data-attr         `data-variant={variant}` + `[data-variant="x"]` rules
 *   lookup-object     `const variantClass = { primary: '…' }` ... `variantClass[variant]`
 *   cva               `buttonVariants({ variant })` over a `cva`/`tv` config
 *   boolean-class     `cn(base, disabled && 'is-disabled')`
 *
 * ## Parse, never execute
 *
 * Everything is read off the written AST (and the written text of the CSS
 * files the component imports). No component renders, no hook runs, no module
 * evaluates, no `cva` call is made. A `cva` is recognised by where its binding
 * was IMPORTED FROM, not by running it.
 *
 * ## Claim only what resolves
 *
 * A binding is claimed only when BOTH ends resolved: the consuming expression
 * AND the thing it points at (a CSS rule on disk, an entry in an object). A
 * guess here lets a later "Add variant" write a rule nothing consumes, which is
 * exactly the silent wrong write this module's callers exist to refuse.
 * Likewise, a prop that is ALSO read by computed code (`variant === 'ghost'`,
 * a switch, a ternary) is `opaque`: cloning one rule would leave that branch
 * unaware of the new member.
 *
 * Reading a pass-through (`<input disabled={disabled}/>`, `{label}` text) does
 * not count against a binding — those do not decide styling.
 *
 * Stylesheets are read through an injected reader (default: the file system,
 * contained to the workspace root), so the analyzer is testable without a disk
 * and can never be pointed outside the project by an import specifier.
 */
import { relative } from 'node:path'
import { Node, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from 'ts-morph'
import type {
  PropDefault,
  SourceRange,
  VariantBinding,
  VariantEntry,
  VariantRule,
} from '@core/component-variants'
import { getFunctionLikeNode } from './componentDeclaration'
import {
  findAttrRule,
  findClassRule,
  importedStylesheets,
  parseStylesheetRules,
  readWorkspaceStylesheet,
  toPosix,
  type CssRuleLocation,
  type ImportedStylesheet,
  type StylesheetAccess,
  type StylesheetReader,
} from './componentVariantStylesheets'
import type { FunctionLike } from './types'

const CLASS_JOINER_NAMES: ReadonlySet<string> = new Set(['cn', 'clsx', 'classNames', 'classnames', 'cx', 'twMerge', 'twJoin'])
/** Module specifiers a `cva`-shaped helper is imported from -> the exported names that are one. */
const CVA_MODULES: Readonly<Record<string, readonly string[]>> = {
  'class-variance-authority': ['cva'],
  'tailwind-variants': ['tv'],
}

type PropVariantKind = 'enum' | 'boolean'

/** What the analyzer needs to know about one prop. `members` are the enum's union members; a boolean's is `['true']`. */
export interface AnalyzedProp {
  name: string
  kind: PropVariantKind
  members: readonly string[]
}

/** Everything read once per component: its function, its source file, and the contained stylesheet access. */
export interface ComponentAnalysisContext extends StylesheetAccess {
  readonly fn: FunctionLike
  readonly sourceFile: SourceFile
}

/** `undefined` for a class component, an unreadable shape, or a file outside the workspace. */
export function createComponentAnalysisContext(
  declaration: Node,
  workspaceRoot: string,
  readStylesheet: StylesheetReader = readWorkspaceStylesheet(workspaceRoot),
): ComponentAnalysisContext | undefined {
  const fn = getFunctionLikeNode(declaration)
  if (!fn) return undefined
  return { fn, sourceFile: fn.getSourceFile(), workspaceRoot, readStylesheet, ruleCache: new Map() }
}

// ---------------------------------------------------------------------------
// Source ranges
// ---------------------------------------------------------------------------

function relFile(ctx: ComponentAnalysisContext, file: SourceFile): string {
  return toPosix(relative(ctx.workspaceRoot, file.getFilePath()))
}

/** A node's span as workspace-relative 1-based line/column. */
export function sourceRangeOf(workspaceRoot: string, node: Node): SourceRange {
  const file = node.getSourceFile()
  const start = file.getLineAndColumnAtPos(node.getStart())
  const end = file.getLineAndColumnAtPos(node.getEnd())
  return {
    file: toPosix(relative(workspaceRoot, file.getFilePath())),
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  }
}

// ---------------------------------------------------------------------------
// Prop access: how the function names the prop
// ---------------------------------------------------------------------------

/** A literal default, read exactly as written; `undefined` for anything computed. */
function literalDefault(node: Node | undefined): PropDefault | undefined {
  if (!node) return undefined
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText()
  if (Node.isNumericLiteral(node)) return node.getLiteralValue()
  if (node.getKind() === SyntaxKind.TrueKeyword) return true
  if (node.getKind() === SyntaxKind.FalseKeyword) return false
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.MinusToken) {
    const operand = node.getOperand()
    if (Node.isNumericLiteral(operand)) return -operand.getLiteralValue()
  }
  return undefined
}

interface PropAccess {
  /** Local identifier names the prop is bound to (`variant`, or the rename `v`). */
  locals: string[]
  /** The props parameter's name when the function takes `props`, so `props.variant` is a use. */
  propsParam: string | undefined
  /** The destructuring default. */
  defaultValue: PropDefault | undefined
  /** Where the prop is declared in the signature (for an `opaque` line when it is never read). */
  declaredAt: Node
}

function propAccessOf(fn: FunctionLike, propName: string): PropAccess {
  const locals: string[] = []
  let defaultValue: PropDefault | undefined
  let declaredAt: Node = fn
  let propsParam: string | undefined

  const readPattern = (pattern: Node): void => {
    if (!Node.isObjectBindingPattern(pattern)) return
    for (const element of pattern.getElements()) {
      const key = element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText()
      if (key !== propName) continue
      const name = element.getNameNode()
      if (Node.isIdentifier(name)) locals.push(name.getText())
      defaultValue ??= literalDefault(element.getInitializer())
      declaredAt = element
    }
  }

  const param = fn.getParameters()[0]
  if (param) {
    const nameNode = param.getNameNode()
    if (Node.isObjectBindingPattern(nameNode)) {
      readPattern(nameNode)
    } else if (Node.isIdentifier(nameNode)) {
      propsParam = nameNode.getText()
      // `const { variant = 'primary' } = props` inside the body.
      for (const declaration of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const init = declaration.getInitializer()
        if (init && Node.isIdentifier(init) && init.getText() === propsParam) readPattern(declaration.getNameNode())
      }
    }
  }
  return { locals, propsParam, defaultValue, declaredAt }
}

/** The destructuring default for `propName`, when the function declares one as a literal. */
export function readPropDefault(declaration: Node, propName: string): PropDefault | undefined {
  const fn = getFunctionLikeNode(declaration)
  return fn ? propAccessOf(fn, propName).defaultValue : undefined
}

// ---------------------------------------------------------------------------
// Use sites
// ---------------------------------------------------------------------------

/** Whether this identifier is a READ of a binding rather than a name in a declaration, key, attribute or type. */
function isReadOfBinding(identifier: Node): boolean {
  const parent = identifier.getParent()
  if (!parent) return false
  if (identifier.getFirstAncestor((a) => Node.isTypeNode(a)) !== undefined) return false
  if (Node.isBindingElement(parent) || Node.isParameterDeclaration(parent) || Node.isVariableDeclaration(parent)) {
    return Node.isVariableDeclaration(parent) ? parent.getInitializer() === identifier : false
  }
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) return false
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) return false
  if (Node.isJsxAttribute(parent)) return false
  if (Node.isPropertySignature(parent) || Node.isMethodDeclaration(parent) || Node.isFunctionDeclaration(parent)) return false
  return true
}

/** Every expression that reads the prop: its local names, and `props.<name>` / `props['<name>']`. */
function readsOfProp(fn: FunctionLike, access: PropAccess, propName: string): Node[] {
  const uses: Node[] = []
  for (const identifier of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const text = identifier.getText()
    if (access.locals.includes(text) && isReadOfBinding(identifier)) {
      uses.push(identifier)
      continue
    }
    if (access.propsParam !== undefined && text === access.propsParam) {
      const parent = identifier.getParent()
      if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === identifier && parent.getName() === propName) {
        uses.push(parent)
      } else if (Node.isElementAccessExpression(parent) && parent.getExpression() === identifier) {
        const arg = parent.getArgumentExpression()
        if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) && arg.getLiteralText() === propName) {
          uses.push(parent)
        }
      }
    }
  }
  return uses.sort((a, b) => a.getStart() - b.getStart())
}

// ---------------------------------------------------------------------------
// Use-site classification
// ---------------------------------------------------------------------------

/** What one use of the prop is. `claim` carries enough to build a binding; `other` is the node that defeated the analyzer. */
type UseClass =
  | { kind: 'passthrough' }
  | { kind: 'claim'; signature: string; build: () => VariantBinding | undefined }
  | { kind: 'other'; node: Node }

function isClassNameAttribute(node: Node): boolean {
  if (!Node.isJsxAttribute(node)) return false
  const name = node.getNameNode().getText()
  return name === 'className' || name === 'class'
}

/** Whether `node` sits where a class string is built: a joiner call, a `className` attribute, or `[...].join(' ')`. */
function isClassBuildingContext(node: Node): boolean {
  for (let current = node.getParent(); current; current = current.getParent()) {
    if (Node.isCallExpression(current)) {
      const callee = current.getExpression()
      if (Node.isIdentifier(callee) && CLASS_JOINER_NAMES.has(callee.getText())) return true
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'join') return true
    }
    if (isClassNameAttribute(current)) return true
    if (Node.isArrowFunction(current) || Node.isFunctionDeclaration(current) || Node.isFunctionExpression(current)) return false
  }
  return false
}

function isEmptyClassValue(node: Node): boolean {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText() === ''
  const kind = node.getKind()
  return kind === SyntaxKind.NullKeyword || kind === SyntaxKind.FalseKeyword || (Node.isIdentifier(node) && node.getText() === 'undefined')
}

function classLiteralText(node: Node): string | undefined {
  return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? node.getLiteralText() : undefined
}

/** Strips `as const` / `satisfies T` / parentheses. */
function unwrapExpression(node: Node): Node {
  let current = node
  while (
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isNonNullExpression(current)
  ) {
    current = current.getExpression()
  }
  return current
}

function propertyNameText(node: Node): string | undefined {
  if (Node.isIdentifier(node)) return node.getText()
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText()
  return undefined
}

/** The object literal a same-file `const name = { … }` (or `as const`) declares. */
function objectLiteralNamed(ctx: ComponentAnalysisContext, name: string): ObjectLiteralExpression | undefined {
  const local = ctx.fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((d) => d.getName() === name)
  const declaration = local ?? ctx.sourceFile.getVariableDeclaration(name)
  const init = declaration?.getInitializer()
  const bare = init ? unwrapExpression(init) : undefined
  return bare && Node.isObjectLiteralExpression(bare) ? bare : undefined
}

function entriesOf(ctx: ComponentAnalysisContext, object: ObjectLiteralExpression, members: readonly string[]): VariantEntry[] {
  const entries: VariantEntry[] = []
  for (const member of members) {
    const property = object
      .getProperties()
      .find((p) => (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) && propertyNameText(p.getNameNode()) === member)
    if (property) entries.push({ member, range: sourceRangeOf(ctx.workspaceRoot, property) })
  }
  return entries
}

/** The imported name (`cva`, `tv`) a call's callee resolves to through a package-import of the cva family, or `undefined`. */
function cvaHelperName(ctx: ComponentAnalysisContext, call: Node): string | undefined {
  if (!Node.isCallExpression(call)) return undefined
  const callee = call.getExpression()
  if (!Node.isIdentifier(callee)) return undefined
  for (const declaration of ctx.sourceFile.getImportDeclarations()) {
    const exported = CVA_MODULES[declaration.getModuleSpecifierValue()]
    if (!exported) continue
    for (const specifier of declaration.getNamedImports()) {
      const local = specifier.getAliasNode()?.getText() ?? specifier.getName()
      if (local === callee.getText() && exported.includes(specifier.getName())) return specifier.getName()
    }
  }
  return undefined
}

function classifyUse(ctx: ComponentAnalysisContext, prop: AnalyzedProp, use: Node, sheets: ImportedStylesheet[]): UseClass {
  const parent = use.getParent()
  if (!parent) return { kind: 'other', node: use }
  const other: UseClass = { kind: 'other', node: use }
  const moduleSheet = (identifier: Node): ImportedStylesheet | undefined =>
    Node.isIdentifier(identifier) ? sheets.find((s) => s.isModule && s.localName === identifier.getText()) : undefined

  // `styles[variant]` / `lookup[variant]`
  if (Node.isElementAccessExpression(parent) && parent.getArgumentExpression() === use) {
    const target = parent.getExpression()
    const sheet = moduleSheet(target)
    if (sheet) {
      return {
        kind: 'claim',
        signature: `css-module:${parent.getText()}`,
        build: () => cssClassBinding(ctx, prop, parent, 'module', [sheet], '', ''),
      }
    }
    if (Node.isIdentifier(target)) {
      const object = objectLiteralNamed(ctx, target.getText())
      if (object) {
        return {
          kind: 'claim',
          signature: `lookup:${target.getText()}`,
          build: () => {
            const entries = entriesOf(ctx, object, prop.members)
            return entries.length === 0
              ? undefined
              : { kind: 'lookup-object', objectName: target.getText(), range: sourceRangeOf(ctx.workspaceRoot, object), entries }
          },
        }
      }
    }
    return other
  }

  // `` `btn-${variant}` `` as a module key, or inside a class string
  if (Node.isTemplateSpan(parent)) {
    const template = parent.getParent()
    if (!Node.isTemplateExpression(template) || template.getTemplateSpans().length !== 1) return other
    const head = template.getHead().getLiteralText()
    const tail = parent.getLiteral().getLiteralText()
    const owner = template.getParent()
    if (Node.isElementAccessExpression(owner) && owner.getArgumentExpression() === template) {
      const sheet = moduleSheet(owner.getExpression())
      if (!sheet) return other
      return {
        kind: 'claim',
        signature: `css-module:${owner.getText()}`,
        build: () => cssClassBinding(ctx, prop, owner, 'module', [sheet], head, tail),
      }
    }
    const globalSheets = sheets.filter((s) => !s.isModule)
    if (globalSheets.length > 0 && (isClassNameAttributeValue(template) || isClassBuildingContext(template))) {
      // `btn btn-${variant} wide` — the class is the whitespace-delimited word the hole sits in.
      const prefix = head.split(/\s+/).pop() ?? ''
      const suffix = tail.split(/\s+/)[0] ?? ''
      return {
        kind: 'claim',
        signature: `global:${template.getText()}`,
        build: () => cssClassBinding(ctx, prop, template, 'global', globalSheets, prefix, suffix),
      }
    }
    return other
  }

  // `data-variant={variant}`
  if (Node.isJsxExpression(parent)) {
    const attribute = parent.getParent()
    if (Node.isJsxAttribute(attribute) && parent.getExpression() === use) {
      const attr = attribute.getNameNode().getText()
      if (attr.startsWith('data-')) {
        return {
          kind: 'claim',
          signature: `data:${attr}`,
          build: () => {
            const rules: VariantRule[] = []
            for (const member of prop.members) {
              const found = firstRuleAcross(ctx, sheets, (rules_) => findAttrRule(rules_, attr, member))
              if (found) rules.push({ member, selector: found.selector, range: found.range })
            }
            return rules.length === 0
              ? undefined
              : { kind: 'data-attr', attr, range: sourceRangeOf(ctx.workspaceRoot, attribute), rules }
          },
        }
      }
      if (isClassNameAttribute(attribute) || attr === 'style') return other
      return { kind: 'passthrough' }
    }
    // `<span>{label}</span>` — text, not styling.
    if (Node.isJsxElement(attribute) || Node.isJsxFragment(attribute)) return { kind: 'passthrough' }
    return other
  }

  // `disabled && 'is-disabled'` / `disabled ? 'is-disabled' : ''`
  if (prop.kind === 'boolean') {
    let literal: Node | undefined
    if (Node.isBinaryExpression(parent) && parent.getLeft() === use && parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
      literal = parent.getRight()
    } else if (Node.isConditionalExpression(parent) && parent.getCondition() === use && isEmptyClassValue(parent.getWhenFalse())) {
      literal = parent.getWhenTrue()
    }
    const className = literal ? classLiteralText(literal) : undefined
    if (literal && className !== undefined && className.trim() !== '' && isClassBuildingContext(parent)) {
      return {
        kind: 'claim',
        signature: `boolean:${className}`,
        build: () => ({ kind: 'boolean-class', range: sourceRangeOf(ctx.workspaceRoot, literal), className }),
      }
    }
    return other
  }

  // `buttonVariants({ variant })` / `{ variant: v }`
  if (Node.isShorthandPropertyAssignment(parent) || (Node.isPropertyAssignment(parent) && parent.getInitializer() === use)) {
    const group = propertyNameText(parent.getNameNode())
    const object = parent.getParent()
    const call = object && Node.isObjectLiteralExpression(object) ? object.getParent() : undefined
    if (group !== undefined && call && Node.isCallExpression(call) && call.getArguments().includes(object!)) {
      const callee = call.getExpression()
      const config = Node.isIdentifier(callee) ? objectCvaConfig(ctx, callee.getText()) : undefined
      if (config) {
        return {
          kind: 'claim',
          signature: `cva:${callee.getText()}:${group}`,
          build: () => {
            const groupObject = cvaGroup(config.variants, group)
            if (!groupObject) return undefined
            const entries = entriesOf(ctx, groupObject, prop.members)
            return entries.length === 0
              ? undefined
              : { kind: 'cva', callee: config.helper, group, range: sourceRangeOf(ctx.workspaceRoot, config.call), entries }
          },
        }
      }
    }
    return other
  }

  return other
}

function isClassNameAttributeValue(node: Node): boolean {
  const expression = node.getParent()
  return Node.isJsxExpression(expression) && isClassNameAttribute(expression.getParent() ?? expression)
}

/** The `cva(...)`/`tv(...)` a same-file const holds, with its `variants` object. */
function objectCvaConfig(
  ctx: ComponentAnalysisContext,
  name: string,
): { helper: string; call: Node; variants: ObjectLiteralExpression } | undefined {
  const declaration = ctx.sourceFile.getVariableDeclaration(name) ?? ctx.fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((d) => d.getName() === name)
  const init = declaration?.getInitializer()
  const call = init ? unwrapExpression(init) : undefined
  if (!call || !Node.isCallExpression(call)) return undefined
  const helper = cvaHelperName(ctx, call)
  if (!helper) return undefined
  for (const argument of call.getArguments()) {
    if (!Node.isObjectLiteralExpression(argument)) continue
    const variants = argument.getProperty('variants')
    const value = variants && Node.isPropertyAssignment(variants) ? variants.getInitializer() : undefined
    if (value && Node.isObjectLiteralExpression(value)) return { helper, call, variants: value }
  }
  return undefined
}

function cvaGroup(variants: ObjectLiteralExpression, group: string): ObjectLiteralExpression | undefined {
  const property = variants.getProperty(group)
  const value = property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined
  return value && Node.isObjectLiteralExpression(value) ? value : undefined
}

function firstRuleAcross(
  ctx: ComponentAnalysisContext,
  sheets: readonly ImportedStylesheet[],
  find: (rules: readonly CssRuleLocation[]) => { selector: string; range: SourceRange } | undefined,
): { selector: string; range: SourceRange } | undefined {
  for (const sheet of sheets) {
    const found = find(parseStylesheetRules(ctx, sheet.absPath))
    if (found) return found
  }
  return undefined
}

function cssClassBinding(
  ctx: ComponentAnalysisContext,
  prop: AnalyzedProp,
  expression: Node,
  scope: 'module' | 'global',
  sheets: readonly ImportedStylesheet[],
  prefix: string,
  suffix: string,
): VariantBinding | undefined {
  const rules: VariantRule[] = []
  for (const member of prop.members) {
    const found = firstRuleAcross(ctx, sheets, (all) => findClassRule(all, `${prefix}${member}${suffix}`))
    if (found) rules.push({ member, selector: found.selector, range: found.range })
  }
  if (rules.length === 0) return undefined
  return {
    kind: 'css-module-class',
    scope,
    expr: expression.getText(),
    classPrefix: prefix,
    classSuffix: suffix,
    range: sourceRangeOf(ctx.workspaceRoot, expression),
    rules,
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function opaque(ctx: ComponentAnalysisContext, node: Node, reason: string): VariantBinding {
  return { kind: 'opaque', file: relFile(ctx, node.getSourceFile()), line: node.getStartLineNumber(), reason }
}

/**
 * How `prop` becomes styling in this component. Always returns a binding
 * (`opaque` included) — callers distinguish "the analyzer did not look" (no
 * context, a class component) by never calling this.
 */
export function analyzeVariantBinding(ctx: ComponentAnalysisContext, prop: AnalyzedProp): VariantBinding {
  const access = propAccessOf(ctx.fn, prop.name)
  const uses = readsOfProp(ctx.fn, access, prop.name)
  if (uses.length === 0) {
    return opaque(ctx, access.declaredAt, `\`${prop.name}\` is never read in the component body, so nothing styles from it`)
  }

  const sheets = importedStylesheets(ctx.sourceFile)
  const claims: Extract<UseClass, { kind: 'claim' }>[] = []
  for (const use of uses) {
    const result = classifyUse(ctx, prop, use, sheets)
    if (result.kind === 'other') {
      return opaque(ctx, result.node, `\`${prop.name}\` is used in computed code at line ${result.node.getStartLineNumber()}`)
    }
    if (result.kind === 'claim') claims.push(result)
  }

  const first = claims[0]
  if (!first) {
    return opaque(ctx, access.declaredAt, `\`${prop.name}\` is only passed through; no style is chosen from it`)
  }
  const mismatched = claims.find((c) => c.signature !== first.signature)
  if (mismatched) {
    return opaque(ctx, uses[0]!, `\`${prop.name}\` is consumed in more than one way (${first.signature} and ${mismatched.signature})`)
  }
  return first.build() ?? opaque(ctx, uses[0]!, `\`${prop.name}\` is consumed by ${first.signature}, but nothing it points at was found on disk`)
}
