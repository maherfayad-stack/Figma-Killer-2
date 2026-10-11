/**
 * jsxLiteralAttribute — the one answer to "is this JSX attribute a LITERAL?".
 *
 * Two sides must agree on it, or the editor offers an edit the server refuses:
 *
 *   - the WRITE side (`setJsxProp`, `setSvgPartAttributes`): only a literal
 *     initializer may be replaced, because baking a value over an expression
 *     deletes the binding from the user's source (WB-11, Invariant 5);
 *   - the READ side (`inlineSvg.ts`'s part stamps, SVG-3): an inner SVG
 *     element's non-literal attributes are listed as code so the canvas never
 *     offers to write them.
 *
 * A literal is: the bare `open` shorthand, `"x"`, `{'x'}`, `` {`x`} `` (no
 * substitutions), `{3}`, `{-3}`, `{+3}`, `{true}`, `{false}`, any of them in
 * parentheses. Everything else — `{c.title}`, `{fn}`, `{[…]}`, `{{…}}` — is
 * code.
 */
import { Node, SyntaxKind, type JsxAttribute } from 'ts-morph'

export function isLiteralJsxAttribute(attribute: JsxAttribute): boolean {
  const initializer = attribute.getInitializer()
  if (!initializer || Node.isStringLiteral(initializer)) return true
  if (!Node.isJsxExpression(initializer)) return false
  let expression = initializer.getExpression()
  while (expression && Node.isParenthesizedExpression(expression)) expression = expression.getExpression()
  if (!expression) return false
  if (Node.isPrefixUnaryExpression(expression)) {
    const operand = expression.getOperand()
    return Node.isNumericLiteral(operand) &&
      (expression.getOperatorToken() === SyntaxKind.MinusToken || expression.getOperatorToken() === SyntaxKind.PlusToken)
  }
  return (
    Node.isStringLiteral(expression) ||
    Node.isNoSubstitutionTemplateLiteral(expression) ||
    Node.isNumericLiteral(expression) ||
    Node.isTrueLiteral(expression) ||
    Node.isFalseLiteral(expression)
  )
}
