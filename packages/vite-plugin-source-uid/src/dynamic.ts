import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

/**
 * `data-dynamic="true"` detection — the editable-surface contract
 * (playbook §0): JSX generated inside a `.map()`/other `CallExpression`
 * callback, a ternary (`ConditionalExpression`), or a logical expression
 * (`&&`/`||`) is rendered live but LOCKED (read-only in the canvas).
 *
 * Implementation walks the real lexical parent chain of the given JSX node
 * (not a global scan), so it is correct by construction: any
 * `CallExpression`/`ConditionalExpression`/`LogicalExpression` found is
 * genuinely an ancestor of this specific node, and the walk naturally
 * cascades dynamic-ness onto every descendant of a dynamic node (a `<li>`
 * two levels inside a `.map()` callback is exactly as dynamic as the
 * callback's immediate return) while leaving unrelated siblings (e.g. the
 * static `<ul>` wrapping `{items.map(...)}`) untouched.
 */
export function isDynamicJsxNode(path: NodePath<t.JSXElement> | NodePath<t.JSXFragment>): boolean {
  let current: NodePath | null = path.parentPath;

  while (current) {
    if (current.isConditionalExpression()) {
      return true;
    }

    if (current.isLogicalExpression()) {
      const operator = current.node.operator;
      if (operator === '&&' || operator === '||') {
        return true;
      }
    }

    if (
      (current.isArrowFunctionExpression() || current.isFunctionExpression()) &&
      current.parentPath !== null &&
      current.parentPath.isCallExpression()
    ) {
      // This node sits inside a function that is itself passed as an
      // argument to some call — the ".map()/other CallExpression callback"
      // case (playbook §0). We don't special-case the callee name (`.map`
      // vs `.filter` vs a custom helper) — the contract says "other
      // CallExpression callback" deliberately broadly.
      return true;
    }

    current = current.parentPath;
  }

  return false;
}
