import {
  Project,
  SyntaxKind,
  type Expression,
  type ObjectLiteralExpression,
  type ObjectLiteralElementLike,
} from 'ts-morph';
import { cssVarForFlatToken, cssVarForTypographyField } from './css-var.js';
import { getPropertyByLogicalName, logicalPropertyName } from './property-name.js';
import type { Token, TokenModel, TokenType } from './types.js';

/**
 * `parseAlmosaferTokensJs` — the PRIMARY parser (ADR-0010, ADR-0022): reads
 * `design-system/src/tokens/tokens.js`'s SIX `export const` object
 * literals (`colors`, `colorsDark`, `spacing`, `rounded`, `elevation`,
 * `typography`) and normalizes them into a flat `TokenModel`.
 *
 * PURE — takes source TEXT, does zero fs IO (playbook §4/P4 "pure library,
 * fs only at the daemon boundary"). Uses ts-morph's in-memory project +
 * the shared literal-AST walker in `parse-literal.ts`'s spirit (kept
 * hand-rolled here rather than routed through `evaluateExpressionToJson`
 * because tokens.js's value vocabulary — string/number/negative-number
 * literals only, never arrays/booleans/nested-beyond-typography — is
 * narrower and benefits from staying string|number typed end-to-end
 * without an `unknown`-typed detour).
 *
 * `colors` = the LIGHT theme, `colorsDark` = the DARK theme (module doc in
 * tokens.js itself: "static values unchanged in dark mode" for keys that
 * only appear in one side, e.g. brand colors like `almosafer`/`whatsapp`
 * only exist in `colors`). Keys present in only one side are treated as
 * theme-static: the missing side falls back to the present side's value.
 */
export function parseAlmosaferTokensJs(sourceText: string): TokenModel {
  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
  const sourceFile = project.createSourceFile('tokens.js', sourceText);

  const exported = new Map<string, ObjectLiteralExpression>();
  for (const varStmt of sourceFile.getVariableStatements()) {
    if (!varStmt.isExported()) continue;
    for (const decl of varStmt.getDeclarations()) {
      const init = decl.getInitializer();
      const obj = init?.asKind(SyntaxKind.ObjectLiteralExpression);
      if (obj) exported.set(decl.getName(), obj);
    }
  }

  const tokens: Token[] = [];

  // --- colors (light) + colorsDark ---------------------------------------
  const colorsLight = exported.get('colors');
  const colorsDark = exported.get('colorsDark');
  const colorKeys = new Set<string>();
  if (colorsLight) for (const key of propertyNames(colorsLight)) colorKeys.add(key);
  if (colorsDark) for (const key of propertyNames(colorsDark)) colorKeys.add(key);
  for (const key of colorKeys) {
    const lightVal = colorsLight ? readLiteral(colorsLight, key) : undefined;
    const darkVal = colorsDark ? readLiteral(colorsDark, key) : undefined;
    const light = lightVal ?? darkVal;
    const dark = darkVal ?? lightVal;
    if (light === undefined || dark === undefined) continue;
    tokens.push({
      name: key,
      group: 'color',
      type: 'color',
      value: { light, dark },
      cssVar: cssVarForFlatToken('color', key),
    });
  }

  // --- flat, theme-independent groups -------------------------------------
  const FLAT_GROUPS = [
    { exportName: 'spacing', group: 'spacing' as const, type: 'dimension' as const },
    { exportName: 'rounded', group: 'rounded' as const, type: 'dimension' as const },
    { exportName: 'elevation', group: 'elevation' as const, type: 'shadow' as const },
  ];
  for (const { exportName, group, type } of FLAT_GROUPS) {
    const obj = exported.get(exportName);
    if (!obj) continue;
    for (const key of propertyNames(obj)) {
      const value = readLiteral(obj, key);
      if (value === undefined) continue;
      tokens.push({
        name: key,
        group,
        type,
        value: { light: value, dark: value },
        cssVar: cssVarForFlatToken(group, key),
      });
    }
  }

  // --- typography (nested: scale -> field -> value) -----------------------
  const typography = exported.get('typography');
  if (typography) {
    for (const scaleProp of typography.getProperties()) {
      const pa = scaleProp.asKind(SyntaxKind.PropertyAssignment);
      if (!pa) continue;
      const scaleName = logicalPropertyName(pa);
      if (scaleName === undefined) continue;
      const scaleObj = pa.getInitializer()?.asKind(SyntaxKind.ObjectLiteralExpression);
      if (!scaleObj) continue;
      for (const field of propertyNames(scaleObj)) {
        const value = readLiteral(scaleObj, field);
        if (value === undefined) continue;
        const type: TokenType =
          field === 'fontFamily'
            ? 'fontFamily'
            : field === 'fontWeight'
              ? 'fontWeight'
              : typeof value === 'number'
                ? 'number'
                : 'dimension';
        tokens.push({
          name: `${scaleName}.${field}`,
          group: 'typography',
          type,
          value: { light: value, dark: value },
          cssVar: cssVarForTypographyField(scaleName, field),
        });
      }
    }
  }

  return { tokens, themes: ['light', 'dark'] };
}

function propertyNames(obj: ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const prop of obj.getProperties()) {
    const name = propertyAssignmentName(prop);
    if (name !== undefined) names.push(name);
  }
  return names;
}

function propertyAssignmentName(prop: ObjectLiteralElementLike): string | undefined {
  const pa = prop.asKind(SyntaxKind.PropertyAssignment);
  if (!pa) return undefined;
  return logicalPropertyName(pa);
}

function readLiteral(obj: ObjectLiteralExpression, key: string): string | number | undefined {
  const prop = getPropertyByLogicalName(obj, key);
  if (!prop) return undefined;
  return evaluateLiteral(prop.getInitializer());
}

function evaluateLiteral(expr: Expression | undefined): string | number | undefined {
  if (!expr) return undefined;
  const str = expr.asKind(SyntaxKind.StringLiteral);
  if (str) return str.getLiteralValue();
  const tmpl = expr.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
  if (tmpl) return tmpl.getLiteralValue();
  const num = expr.asKind(SyntaxKind.NumericLiteral);
  if (num) return num.getLiteralValue();
  const unary = expr.asKind(SyntaxKind.PrefixUnaryExpression);
  if (unary && unary.getOperatorToken() === SyntaxKind.MinusToken) {
    const operand = unary.getOperand().asKind(SyntaxKind.NumericLiteral);
    if (operand) return -operand.getLiteralValue();
  }
  return undefined;
}
