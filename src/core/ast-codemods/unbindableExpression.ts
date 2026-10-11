/**
 * unbindableExpression - which pieces of code a literal may REPLACE when the
 * user types over them (G-6, OD-20).
 *
 * `setJsxProp` and `setJsxText` refuse to write over code: `title={c.heading}`
 * baked into `title="Where to?"` deletes the binding (invariant 5). Typing into
 * a field that shows such a value is the one explicit intent that outranks it -
 * the caller says `unbind: true`, the editor shows what was replaced and offers
 * Undo (the undo journal restores the bytes). This module is the gate on the
 * server side of that promise: even with `unbind: true`, only an expression that
 * is a plain VALUE is replaced.
 *
 * What is never replaced, whatever the flag says, because the user was not
 * editing a value:
 *
 *   - **markup** - anything with JSX inside (`{cond && <b>x</b>}`, `icon={<svg/>}`,
 *     a `.map` callback that returns elements). Those open their own selection;
 *   - **a function** - `onClick={() => save()}` is behaviour, not copy;
 *   - **structured data** - `items={[...]}`, `style={{...}}` as an attribute value
 *     is a whole array/object the text field never showed.
 *
 * Everything else is a value expression: an identifier (`{count}`), a member
 * chain, a call (`{t('x')}`), a template, a ternary or an operator.
 */
import { Node, SyntaxKind } from 'ts-morph'

const MARKUP_KINDS: readonly SyntaxKind[] = [SyntaxKind.JsxElement, SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxFragment]
const FUNCTION_KINDS: readonly SyntaxKind[] = [SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression, SyntaxKind.ClassExpression]

/**
 * True when `expression` is a plain value a typed literal may replace. `undefined`
 * (an empty `{}`) is not an expression. A function NESTED in the value is fine
 * (`names.map((n) => n.toUpperCase()).join(', ')` computes a string); a function
 * AS the value is behaviour, and markup anywhere inside is never a value.
 */
export function isUnbindableExpression(expression: Node | undefined): boolean {
  if (!expression) return false
  let top: Node = expression
  while (Node.isParenthesizedExpression(top)) top = top.getExpression()
  if (Node.isObjectLiteralExpression(top) || Node.isArrayLiteralExpression(top)) return false
  if (FUNCTION_KINDS.includes(top.getKind())) return false
  return ![top, ...top.getDescendants()].some((node) => MARKUP_KINDS.includes(node.getKind()))
}
