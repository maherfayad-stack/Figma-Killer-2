import { SyntaxKind, type Expression } from 'ts-morph';

/**
 * A generic, pure "evaluate this literal AST expression to a plain JS
 * value" walker — the shared engine behind both `parseAlmosaferTokensJs`
 * (tokens.js's flat/nested object-literal exports) and
 * `parseComponentMeta` (meta.ts's `export default {...} satisfies
 * ComponentMeta` literal). NEVER executes source code (no `eval`/`Function`
 * /dynamic `import()`); it only understands the closed set of literal AST
 * node kinds actually used by these two source shapes: string/numeric/
 * boolean/null literals, unary-minus numbers, arrays, and nested object
 * literals. Anything else (function calls, identifiers other than
 * `undefined`, spreads, computed keys) evaluates to `undefined` for that
 * slot — the caller's schema validation (zod) is what turns "field missing"
 * into a loud, actionable error, not this walker silently guessing.
 */
export type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

export function evaluateExpressionToJson(expr: Expression | undefined): JsonValue {
  if (!expr) return undefined;

  const asExpr = expr.asKind(SyntaxKind.AsExpression);
  if (asExpr) return evaluateExpressionToJson(asExpr.getExpression());

  const satisfiesExpr = expr.asKind(SyntaxKind.SatisfiesExpression);
  if (satisfiesExpr) return evaluateExpressionToJson(satisfiesExpr.getExpression());

  const paren = expr.asKind(SyntaxKind.ParenthesizedExpression);
  if (paren) return evaluateExpressionToJson(paren.getExpression());

  const str = expr.asKind(SyntaxKind.StringLiteral);
  if (str) return str.getLiteralValue();

  const tmpl = expr.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
  if (tmpl) return tmpl.getLiteralValue();

  const num = expr.asKind(SyntaxKind.NumericLiteral);
  if (num) return num.getLiteralValue();

  if (expr.getKind() === SyntaxKind.TrueKeyword) return true;
  if (expr.getKind() === SyntaxKind.FalseKeyword) return false;
  if (expr.getKind() === SyntaxKind.NullKeyword) return null;

  const ident = expr.asKind(SyntaxKind.Identifier);
  if (ident && ident.getText() === 'undefined') return undefined;

  const unary = expr.asKind(SyntaxKind.PrefixUnaryExpression);
  if (unary && unary.getOperatorToken() === SyntaxKind.MinusToken) {
    const operandValue = evaluateExpressionToJson(unary.getOperand());
    return typeof operandValue === 'number' ? -operandValue : undefined;
  }

  const arr = expr.asKind(SyntaxKind.ArrayLiteralExpression);
  if (arr) return arr.getElements().map((el) => evaluateExpressionToJson(el));

  const obj = expr.asKind(SyntaxKind.ObjectLiteralExpression);
  if (obj) {
    const out: { [key: string]: JsonValue } = {};
    for (const prop of obj.getProperties()) {
      const pa = prop.asKind(SyntaxKind.PropertyAssignment);
      if (!pa) continue; // shorthand/spread/method properties are not part
      // of tokens.js's or meta.ts's literal vocabulary — skipped, not errored.
      // `pa.getName()` returns the RAW quoted source text for a string-
      // literal key (e.g. `"'aria-label'"`, quotes and all) rather than the
      // unquoted value — read the literal value directly off the name node
      // for string/numeric keys instead (matches `jsx-props.ts`'s handling
      // of renamed binding-pattern elements).
      const nameNode = pa.getNameNode();
      const strName = nameNode.asKind(SyntaxKind.StringLiteral);
      const numName = nameNode.asKind(SyntaxKind.NumericLiteral);
      let name: string;
      if (strName) {
        name = strName.getLiteralValue();
      } else if (numName) {
        name = numName.getText();
      } else {
        try {
          name = pa.getName();
        } catch {
          continue; // computed property name — out of scope for both source shapes.
        }
      }
      out[name] = evaluateExpressionToJson(pa.getInitializer());
    }
    return out;
  }

  return undefined;
}
