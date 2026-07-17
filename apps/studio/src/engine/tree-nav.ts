import type { NodeUid, TreeNode } from '@ccs/protocol';

export interface TreeParentInfo {
  parent: TreeNode;
  index: number;
}

/** Predicts a freshly-inserted child's uid from its parent's (frozen
 * astPath encoding, ADR-0017: `<parentAstPath>.<siblingIndex>` — see the
 * CR docs in `ComponentsPanel.tsx`/`use-component-insert.ts` for why this
 * is a best-effort prediction, not a guarantee). The cast is safe: any
 * `NodeUid` already matches `<relPath>.tsx:<astPath>`, and appending
 * `.<index>` to the astPath half preserves that shape. */
export function childUid(parentUid: NodeUid, index: number): NodeUid {
  return `${parentUid}.${index}` as NodeUid;
}

/** Finds a node's parent + its index among the parent's children — the
 * ast-engine ops (`delete-node`, `move-node`, `insert-node`) all address
 * "a position among siblings", which `TreeNode` (child-pointing only)
 * doesn't carry directly. Returns `null` for the root (no parent) or an
 * unresolvable uid. */
export function findParent(root: TreeNode, uid: string): TreeParentInfo | null {
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (!child) continue;
    if (child.uid === uid) return { parent: root, index: i };
    const nested = findParent(child, uid);
    if (nested) return nested;
  }
  return null;
}

/** FP-4a (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4, two-way selection
 * sync bullet): the full ancestor chain from `root` to `uid` INCLUSIVE
 * (outermost -> innermost, root first) — `null` if `uid` isn't in this
 * tree. Used to build a `SelectNodeRequest.breadcrumb` (`@ccs/canvas`) from
 * the studio's own live `TreeNode` tree when a Layers-panel selection needs
 * to drive the canvas's bridge/overlay breadcrumb, mirroring the ORDER
 * `@ccs/bridge`'s own `buildBreadcrumb` produces from the DOM side (same
 * "outermost -> innermost, ending with the target node" convention). */
export function findPath(root: TreeNode, uid: string): TreeNode[] | null {
  if (root.uid === uid) return [root];
  for (const child of root.children) {
    const nested = findPath(child, uid);
    if (nested) return [root, ...nested];
  }
  return null;
}
