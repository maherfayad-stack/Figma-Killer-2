/**
 * detachConstantFold — a detached conditional whose condition is fully known
 * once the call site's values are in is written as the branch it takes, not as
 * the test that picks it.
 *
 * `{size === 'large' ? <Big/> : <Small/>}` with `size="large"` at the call site
 * used to be written into the page as `{'large' === 'large' ? <Big/> : <Small/>}`
 * (and `{showTitle && <h1/>}` with the prop omitted as `{undefined && <h1/>}`):
 * correct, and unreadable — and it also dragged in every import only the branch
 * NOT taken needed, because the planner admitted each name it rendered. Writing
 * the branch that renders is what a person detaching the instance would write.
 *
 * ## What counts as known
 *
 * Only LITERALS: string, number, boolean, `null`, `undefined`, combined with
 * `===`, `!==`, `==`/`!=` (only where JavaScript's coercion cannot surprise: a
 * nullish test, or two operands of one type), `!`, `&&`, `||` and `??`. A
 * reference is known only when it is a component prop the call site gave a
 * literal (or omitted, which IS `undefined`, or defaulted to a literal). A
 * call, a member of anything but `...rest`, a body value, a hook, an imported
 * binding or a comparison with `<`/`>` is NOT known — the conditional stays
 * as written, which is always faithful. Nothing here executes the user's code:
 * it reads the same literals the planner would have copied across, and applies
 * the operators the language defines for them.
 *
 * A condition made only of the component's OWN literals (`true ? a : b`) is
 * left alone: the author wrote it, and detach is not a cleanup pass. At least
 * one prop must take part.
 *
 * Pure: the caller supplies how a reference reads.
 */
import { Node, SyntaxKind } from 'ts-morph'

/** A JavaScript primitive the evaluator can reason about. Boxed so `{ v: undefined }` and "unknown" are different answers. */
export interface Literal {
  v: string | number | boolean | null | undefined
}

/** The literal a node IS, or `undefined` when it is anything else. */
export function literalOfNode(node: Node): Literal | undefined {
  if (Node.isParenthesizedExpression(node)) return literalOfNode(node.getExpression())
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return { v: node.getLiteralValue() }
  if (Node.isNumericLiteral(node)) return { v: node.getLiteralValue() }
  if (Node.isTrueLiteral(node)) return { v: true }
  if (Node.isFalseLiteral(node)) return { v: false }
  if (Node.isNullLiteral(node)) return { v: null }
  if (Node.isIdentifier(node) && node.getText() === 'undefined') return { v: undefined }
  return undefined
}

export function isTruthy(literal: Literal): boolean {
  return Boolean(literal.v)
}

/** How a reference in a condition reads: a literal, or `undefined` for "not known". */
export type ReadReference = (reference: Node) => Literal | undefined

function looseEquals(left: Literal, right: Literal): boolean | undefined {
  const leftNullish = left.v === null || left.v === undefined
  const rightNullish = right.v === null || right.v === undefined
  if (leftNullish || rightNullish) return leftNullish && rightNullish
  // Two operands of one type compare as `===` would; across types JavaScript
  // coerces, and that is exactly the surprise this refuses to reason about.
  return typeof left.v === typeof right.v ? left.v === right.v : undefined
}

/** The literal `node` evaluates to, or `undefined` when any part of it is not known. */
export function evaluateLiteral(node: Node, read: ReadReference): Literal | undefined {
  if (Node.isParenthesizedExpression(node)) return evaluateLiteral(node.getExpression(), read)
  const literal = literalOfNode(node)
  if (literal) return literal
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) return read(node)
  if (Node.isPrefixUnaryExpression(node)) {
    // `!` is the only unary operator whose result needs no arithmetic.
    if (node.getOperatorToken() !== SyntaxKind.ExclamationToken) return undefined
    const operand = evaluateLiteral(node.getOperand(), read)
    return operand ? { v: !isTruthy(operand) } : undefined
  }
  if (!Node.isBinaryExpression(node)) return undefined
  const operator = node.getOperatorToken().getText()
  if (operator === '&&' || operator === '||' || operator === '??') {
    const left = evaluateLiteral(node.getLeft(), read)
    if (!left) return undefined
    const keepsLeft = operator === '&&' ? !isTruthy(left) : operator === '||' ? isTruthy(left) : left.v !== null && left.v !== undefined
    return keepsLeft ? left : evaluateLiteral(node.getRight(), read)
  }
  if (operator !== '===' && operator !== '!==' && operator !== '==' && operator !== '!=') return undefined
  const left = evaluateLiteral(node.getLeft(), read)
  const right = evaluateLiteral(node.getRight(), read)
  if (!left || !right) return undefined
  const equal = operator === '===' || operator === '!==' ? left.v === right.v : looseEquals(left, right)
  if (equal === undefined) return undefined
  return { v: operator === '===' || operator === '==' ? equal : !equal }
}

/** What a conditional position takes once its test is known: the node that renders, or `null` for "renders nothing". */
export type FoldedBranch = { branch: Node } | { branch: null }

/** Values a `&&` leaves behind that React renders as nothing — the only falsy left operands that may be dropped. */
function rendersNothing(literal: Literal): boolean {
  return literal.v === false || literal.v === null || literal.v === undefined || literal.v === ''
}

/**
 * Which branch `expression` takes, or `undefined` when it cannot be decided.
 * Handles `test ? a : b`, `test && a` and `test || a`; `inChild` is true where
 * the result is a JSX child, the one position a falsy `&&` operand may simply
 * vanish.
 */
export function foldConditional(expression: Node, read: ReadReference, inChild: boolean): FoldedBranch | undefined {
  if (Node.isConditionalExpression(expression)) {
    const test = evaluateLiteral(expression.getCondition(), read)
    if (!test) return undefined
    return { branch: isTruthy(test) ? expression.getWhenTrue() : expression.getWhenFalse() }
  }
  if (!Node.isBinaryExpression(expression)) return undefined
  const operator = expression.getOperatorToken().getText()
  if (operator !== '&&' && operator !== '||') return undefined
  const left = evaluateLiteral(expression.getLeft(), read)
  if (!left) return undefined
  if (operator === '&&') {
    if (isTruthy(left)) return { branch: expression.getRight() }
    return inChild && rendersNothing(left) ? { branch: null } : undefined
  }
  // `a || b` with a falsy `a` is `b`; with a truthy `a` it is `a` itself, which
  // is a value to render rather than a branch to choose.
  return isTruthy(left) ? undefined : { branch: expression.getRight() }
}
