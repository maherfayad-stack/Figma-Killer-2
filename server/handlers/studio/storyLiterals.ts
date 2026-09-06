/**
 * storyLiterals — the AST-reading primitives `storyDiscovery.ts` classifies a
 * Storybook CSF file with.
 *
 * Two genuinely separate reasons to change, which is why they are two files:
 * this one changes when the SHAPES a source file can spell change (a new way to
 * wrap a value in a type assertion, a literal form the reader should
 * understand); `storyDiscovery.ts` changes when the accepted STORY subset or
 * its refusal vocabulary changes. Nothing here knows what a story is.
 *
 * Everything is total and non-throwing: a shape this module cannot read yields
 * `undefined`, never an exception and never a guess, which is what lets the
 * classifier turn each one into a NAMED refusal instead of a stack trace.
 */
import { Node, SyntaxKind, type Expression, type ObjectLiteralExpression } from 'ts-morph'
import type { FunctionLike, ParsedPropValue } from '@core/page-parser'

/**
 * An object literal read as JSON-shaped prop values. `undefined` means the
 * literal itself cannot be read AT ALL (it spreads). An individual entry whose
 * value is not a literal — a function, an identifier, a call — is DROPPED,
 * matching `staticValueToPropValue`'s rule for a JSX prop: a stub would be a
 * guess about what the code produces.
 */
export function readObjectLiteral(object: ObjectLiteralExpression): Record<string, ParsedPropValue> | undefined {
  const result: Record<string, ParsedPropValue> = {}
  for (const property of object.getProperties()) {
    if (Node.isSpreadAssignment(property)) return undefined
    if (!Node.isPropertyAssignment(property)) continue
    const initializer = property.getInitializer()
    if (!initializer) continue
    const value = readLiteral(initializer)
    if (value !== undefined) result[stripQuotes(property.getName())] = value
  }
  return result
}

/** One literal value, or `undefined` when the expression is not one. Mirrors the scalar/array/object set `ParsedPropValue` can carry. */
export function readLiteral(expression: Expression): ParsedPropValue | undefined {
  const node = unwrapTypeCasts(expression)
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue()
  if (Node.isNumericLiteral(node)) return node.getLiteralValue()
  if (Node.isTrueLiteral(node)) return true
  if (Node.isFalseLiteral(node)) return false
  if (Node.isPrefixUnaryExpression(node)) {
    const operand = node.getOperand()
    if (node.getOperatorToken() === SyntaxKind.MinusToken && Node.isNumericLiteral(operand)) {
      return -operand.getLiteralValue()
    }
    return undefined
  }
  if (Node.isArrayLiteralExpression(node)) {
    const items: ParsedPropValue[] = []
    for (const element of node.getElements()) {
      const item = readLiteral(element)
      // One unreadable item declines the whole array — the same rule the
      // parser applies to a structured JSX prop, for the same reason: a
      // silently-shortened array is a lie about the source.
      if (item === undefined) return undefined
      items.push(item)
    }
    return items
  }
  if (Node.isObjectLiteralExpression(node)) return readObjectLiteral(node)
  return undefined
}

/** Whether the KEY is written at all, whatever its value — so a shorthand (`{ play }`) counts. */
export function hasProperty(object: ObjectLiteralExpression, name: string): boolean {
  return object.getProperty(name) !== undefined
}

/** A `name: <value>` property's value expression, or `undefined` when the key is absent or is not a plain assignment. */
export function propertyValue(object: ObjectLiteralExpression, name: string): Expression | undefined {
  const property = object.getProperty(name)
  if (!property || !Node.isPropertyAssignment(property)) return undefined
  return property.getInitializer()
}

/** `title: 'Data/Chip'` — the string, or `undefined` when the value is anything else. */
export function stringProperty(object: ObjectLiteralExpression, name: string): string | undefined {
  const value = propertyValue(object, name)
  if (!value) return undefined
  const node = unwrapTypeCasts(value)
  return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? node.getLiteralValue() : undefined
}

/** `component: Button` / `component: Ariakit.Button` — the identifier chain as written, which is what `resolveComponentSources` classifies. */
export function identifierChainProperty(object: ObjectLiteralExpression, name: string): string | undefined {
  const value = propertyValue(object, name)
  if (!value) return undefined
  const node = unwrapTypeCasts(value)
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) return node.getText()
  return undefined
}

/** `x as Meta<T>`, `x satisfies Meta<T>`, `(x)` — all wrap the value without changing it. */
export function unwrapTypeCasts(expression: Expression): Expression {
  let current = expression
  for (;;) {
    if (Node.isAsExpression(current) || Node.isSatisfiesExpression(current) || Node.isParenthesizedExpression(current)) {
      current = current.getExpression()
      continue
    }
    return current
  }
}

export function unwrapParens(node: Node): Node {
  let current = node
  while (Node.isParenthesizedExpression(current)) current = current.getExpression()
  return current
}

export function isJsxExpression(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node)
}

export function isFunctionLike(node: Node): node is FunctionLike {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node)
}

/** `'aria-label'` and `"aria-label"` are the same key. */
export function stripQuotes(name: string): string {
  return name.replace(/^['"`]|['"`]$/g, '')
}
