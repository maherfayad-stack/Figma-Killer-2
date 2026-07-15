import { SyntaxKind, type ObjectLiteralExpression, type PropertyAssignment } from 'ts-morph';

/**
 * ts-morph's `PropertyAssignment.getName()` returns the property's RAW
 * SOURCE TEXT for a string-literal-named key — for a digit-leading token
 * key that can't be a bare JS identifier (`design-system/src/tokens/
 * tokens.js`'s `spacing` export: `'2xs'`, `'2xl'`, `'3xl'`, `'4xl'`),
 * `getName()` returns the literal text INCLUDING THE QUOTES (`"'2xl'"`),
 * not the logical value (`"2xl"`). Likewise `ObjectLiteralExpression.
 * getProperty(name)` does an exact source-text match, so `getProperty
 * ('2xl')` (unquoted) never finds the quoted declaration. Every tokens.js
 * reader/writer in this package needs the LOGICAL (unquoted) key
 * consistently — this is the ONE shared implementation both `parse-
 * almosafer.ts` (read) and `edit-almosafer-tokens.ts` (write) use, so the
 * unquoting logic can't drift between them.
 */
export function logicalPropertyName(pa: PropertyAssignment): string | undefined {
  const nameNode = pa.getNameNode();
  const strLit = nameNode.asKind(SyntaxKind.StringLiteral);
  if (strLit) return strLit.getLiteralValue();
  const noSub = nameNode.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
  if (noSub) return noSub.getLiteralValue();
  try {
    return pa.getName();
  } catch {
    return undefined;
  }
}

/** Find a property by its LOGICAL (unquoted) name — see module doc for why
 * ts-morph's own `getProperty(name)` can't be used directly here. */
export function getPropertyByLogicalName(
  obj: ObjectLiteralExpression,
  key: string,
): PropertyAssignment | undefined {
  for (const prop of obj.getProperties()) {
    const pa = prop.asKind(SyntaxKind.PropertyAssignment);
    if (!pa) continue;
    if (logicalPropertyName(pa) === key) return pa;
  }
  return undefined;
}
