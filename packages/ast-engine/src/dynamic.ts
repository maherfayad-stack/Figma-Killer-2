import { Node, SyntaxKind } from 'ts-morph';

/**
 * Dynamic-node detection — the ts-morph PORT of
 * `packages/vite-plugin-source-uid/src/dynamic.ts`'s `isDynamicJsxNode`,
 * ratified by ADR-0018 item 6: "Editable-surface enforcement (§0) is
 * computed from AST structure, not the DOM — same rule as
 * `vite-plugin-source-uid/src/dynamic.ts`".
 *
 * Walks the real lexical parent chain of a JSX path node. Any node whose
 * ancestor chain crosses a `ConditionalExpression` (ternary), a
 * `&&`/`||` logical `BinaryExpression` (the TS AST has no separate
 * `LogicalExpression` kind — `&&`/`||`/other binary operators all parse as
 * `BinaryExpression`, distinguished by the operator token), or an
 * arrow/function expression that is itself an argument to a `CallExpression`
 * (the `.map()`/other-callback case) is dynamic — and so is every
 * descendant of a dynamic node, since the walk naturally cascades.
 */
export function isDynamicJsxNode(node: Node): boolean {
  let current: Node | undefined = node.getParent();

  while (current) {
    if (Node.isConditionalExpression(current)) {
      return true;
    }

    if (Node.isBinaryExpression(current)) {
      const operatorKind = current.getOperatorToken().getKind();
      if (
        operatorKind === SyntaxKind.AmpersandAmpersandToken ||
        operatorKind === SyntaxKind.BarBarToken
      ) {
        return true;
      }
    }

    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      const parent = current.getParent();
      if (parent && Node.isCallExpression(parent)) {
        return true;
      }
    }

    current = current.getParent();
  }

  return false;
}
