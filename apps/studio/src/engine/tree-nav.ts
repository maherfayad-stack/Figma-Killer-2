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
