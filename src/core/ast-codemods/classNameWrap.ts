/**
 * classNameWrap — how a class ADD joins a `className` expression this codemod
 * cannot read into (P3-C, WB-18). Split out of `setJsxClassName.ts`, which owns
 * WHEN to wrap (an ADD, never a REMOVE — see its "Wrapping an expression");
 * this module owns WHAT the wrapped expression is spelled as.
 */
import { Node, SyntaxKind, type Expression, type SourceFile } from 'ts-morph'
import { CLASS_NAME_JOIN_BUILTIN_NAMES } from '@core/page-parser'
import { topLevelBindingNames } from './importReconcile'

/** The tokens one ADD attaches: plain class names, and CSS-Module member expressions (`styles.row`). */
export interface ClassTokensToAdd {
  literals: readonly string[]
  expressions: readonly string[]
}

/** Shapes that can evaluate to a class string — the only ones an ADD wraps. */
export function isWrappableClassExpression(expr: Expression): boolean {
  if (
    Node.isIdentifier(expr) ||
    Node.isPropertyAccessExpression(expr) ||
    Node.isElementAccessExpression(expr) ||
    Node.isCallExpression(expr) ||
    Node.isConditionalExpression(expr) ||
    Node.isNonNullExpression(expr) ||
    Node.isAsExpression(expr)
  ) {
    return true
  }
  if (Node.isParenthesizedExpression(expr)) return isWrappableClassExpression(expr.getExpression())
  if (Node.isBinaryExpression(expr)) {
    const operator = expr.getOperatorToken().getKind()
    return (
      operator === SyntaxKind.BarBarToken ||
      operator === SyntaxKind.AmpersandAmpersandToken ||
      operator === SyntaxKind.QuestionQuestionToken
    )
  }
  return false
}

/** The class-join helper this file already has in scope, if any — its own idiom wins over a template. */
function joinerInScope(sourceFile: SourceFile): string | undefined {
  const names = topLevelBindingNames(sourceFile)
  return [...CLASS_NAME_JOIN_BUILTIN_NAMES].find((name) => names.has(name))
}

function isPlainStringBranch(node: Node): boolean {
  const inner = Node.isParenthesizedExpression(node) ? node.getExpression() : node
  return Node.isStringLiteral(inner) || Node.isNoSubstitutionTemplateLiteral(inner)
}

/**
 * `cn(expr, "a")` with a join helper in scope, else `` `a ${expr || ''}` `` —
 * the new tokens FIRST, so the parser's partial-template prefix keeps them.
 * See "Wrapping an expression" in this file's doc.
 */
export function wrapExpressionWithTokens(expr: Expression, add: ClassTokensToAdd, sourceFile: SourceFile): string {
  const text = expr.getText()
  const joiner = joinerInScope(sourceFile)
  if (joiner) {
    const args = [text, ...(add.literals.length > 0 ? [JSON.stringify(add.literals.join(' '))] : []), ...add.expressions]
    return `${joiner}(${args.join(', ')})`
  }
  const alwaysString =
    Node.isConditionalExpression(expr) && isPlainStringBranch(expr.getWhenTrue()) && isPlainStringBranch(expr.getWhenFalse())
  const bare =
    Node.isIdentifier(expr) ||
    Node.isPropertyAccessExpression(expr) ||
    Node.isElementAccessExpression(expr) ||
    Node.isCallExpression(expr) ||
    Node.isParenthesizedExpression(expr) ||
    Node.isNonNullExpression(expr)
  const tail = alwaysString ? text : bare ? `${text} || ''` : `(${text}) || ''`
  const parts = [...add.literals, ...add.expressions.map((expression) => '${' + expression + '}'), '${' + tail + '}']
  return '`' + parts.join(' ') + '`'
}
