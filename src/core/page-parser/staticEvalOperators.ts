/**
 * staticEvalOperators — Tier A operators over already-resolved literals:
 * arithmetic, string concatenation, unary `+`/`-`/`!`, and the three
 * value-producing logical operators (`&&`, `||`, `??`).
 *
 * These are pure functions of source text. Nothing here executes user code, so
 * none of it approaches §7.7's Tier D ban — that ban is about *choosing* what
 * renders (JSX branch selection, hook state, effects), not about multiplying two
 * numbers the source spells out.
 *
 * Their absence was quietly expensive, because arithmetic in a JSX value is
 * ordinary React:
 *
 *   const CIRCUMFERENCE = 2 * Math.PI * RADIUS   // every progress ring
 *   strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
 *   {total * quantity}
 *   {title || 'Untitled'}
 *
 * Split from `staticEvalCore` to keep that module under the size ceiling, along
 * the same seam the rest of the evaluator uses: `evaluateNode` dispatches, and
 * each operand comes back through the callback it hands in — so recursion, the
 * step budget, and the depth guard all stay owned by the core.
 */
import { Node, SyntaxKind } from 'ts-morph'
import type { BinaryExpression, PrefixUnaryExpression } from 'ts-morph'
import type { StaticValue } from './staticEvalTypes'

/** Resolves one operand — `evaluateNode`, bound to the current scope/budget/depth. */
type EvaluateOperand = (node: Node) => StaticValue

function unresolved(reason: string): StaticValue {
  return { kind: 'unresolved', reason }
}

/**
 * `&&`/`||`/`??` in VALUE position return one of their operands, not a boolean —
 * `{label || 'Untitled'}` renders a string. (`evaluateCondition` handles the
 * same tokens in CONDITION position, where a boolean is what's wanted.)
 */
function evaluateLogical(
  expr: BinaryExpression,
  opKind: SyntaxKind,
  evaluate: EvaluateOperand,
): StaticValue | undefined {
  if (
    opKind !== SyntaxKind.AmpersandAmpersandToken &&
    opKind !== SyntaxKind.BarBarToken &&
    opKind !== SyntaxKind.QuestionQuestionToken
  ) {
    return undefined
  }

  const left = evaluate(expr.getLeft())
  if (left.kind !== 'literal') return left.kind === 'unresolved' ? left : undefined

  const takeRight = opKind === SyntaxKind.QuestionQuestionToken
    ? left.value === null || left.value === undefined
    : opKind === SyntaxKind.AmpersandAmpersandToken
      ? Boolean(left.value)
      : !left.value
  return takeRight ? evaluate(expr.getRight()) : left
}

/** `+ - * / % **`, plus `+` as string concatenation when either side is a string. */
function applyArithmetic(opKind: SyntaxKind, left: unknown, right: unknown): string | number | undefined {
  if (opKind === SyntaxKind.PlusToken) {
    if (typeof left === 'string' || typeof right === 'string') return `${String(left)}${String(right)}`
    if (typeof left !== 'number' || typeof right !== 'number') return undefined
    return left + right
  }
  if (typeof left !== 'number' || typeof right !== 'number') return undefined
  switch (opKind) {
    case SyntaxKind.MinusToken: return left - right
    case SyntaxKind.AsteriskToken: return left * right
    // A division by zero yields Infinity/NaN, which is not a value worth putting
    // in the DOM — decline instead so the attribute is simply omitted.
    case SyntaxKind.SlashToken: return right === 0 ? undefined : left / right
    case SyntaxKind.PercentToken: return right === 0 ? undefined : left % right
    case SyntaxKind.AsteriskAsteriskToken: return left ** right
    default: return undefined
  }
}

/**
 * A binary expression's value, or `undefined` when this module does not own the
 * operator (comparisons and assignments are handled elsewhere) so the caller can
 * fall through to its own handling.
 */
export function evaluateBinaryOperator(
  expr: BinaryExpression,
  evaluate: EvaluateOperand,
): StaticValue | undefined {
  const opKind = expr.getOperatorToken().getKind()

  const logical = evaluateLogical(expr, opKind, evaluate)
  if (logical !== undefined) return logical

  const left = evaluate(expr.getLeft())
  const right = evaluate(expr.getRight())
  if (left.kind === 'unresolved') return left
  if (right.kind === 'unresolved') return right
  if (left.kind !== 'literal' || right.kind !== 'literal') return undefined

  const value = applyArithmetic(opKind, left.value, right.value)
  if (value === undefined) return undefined
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return unresolved('arithmetic produced a non-finite number')
  }
  return { kind: 'literal', value }
}

/**
 * `-x` / `+x` / `!x`. Also what makes a plain negative number literal work:
 * `-1` is a prefix expression, not a numeric literal, so `top={-1}` resolved to
 * nothing before this.
 */
export function evaluateUnaryOperator(
  expr: PrefixUnaryExpression,
  evaluate: EvaluateOperand,
): StaticValue | undefined {
  const opKind = expr.getOperatorToken()
  if (
    opKind !== SyntaxKind.MinusToken &&
    opKind !== SyntaxKind.PlusToken &&
    opKind !== SyntaxKind.ExclamationToken
  ) {
    return undefined
  }

  const operand = evaluate(expr.getOperand())
  if (operand.kind === 'unresolved') return operand
  if (operand.kind !== 'literal') return undefined

  if (opKind === SyntaxKind.ExclamationToken) return { kind: 'literal', value: !operand.value }
  if (typeof operand.value !== 'number') return undefined
  return { kind: 'literal', value: opKind === SyntaxKind.MinusToken ? -operand.value : operand.value }
}
