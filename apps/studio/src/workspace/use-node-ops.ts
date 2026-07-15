import * as React from 'react';
import { isNodeUid, type TreeNode } from '@ccs/protocol';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { findParent } from '../engine/tree-nav.js';
import { useWorkspaceStore } from './workspace-store.js';

/**
 * Node-level operations backing `LayersPanel`'s context menu + the
 * keyboard map (playbook §2.1 `context_menu.cljs`, §4/P5: "copy/paste
 * (JSX-aware clipboard via ast-engine serialize), duplicate, delete,
 * wrap-in-container, open file in IDE").
 *
 * CR (ast-engine surface gap): the FROZEN `CanvasOp` union (Appendix B /
 * ADR-0018) has no "clone this exact node's full JSX (incl. its own
 * subtree/props)" primitive — `insert-node`'s `element` source is a bare
 * `{tag, classes?}`, and its `ds-component` source only knows a component
 * NAME, not an arbitrary captured node. So `copy`/`paste`/`duplicate` here
 * are a best-effort approximation (insert a same-tag/no-props element),
 * not a byte-exact clone — flagged as a CR for a future `ast-engine`
 * change (a `clone-node` op, or letting `insert-node`'s `element` source
 * carry a serialized JSX string) rather than silently claiming full
 * fidelity.
 */
export interface NodeOps {
  copy: (node: TreeNode) => void;
  paste: (node: TreeNode) => void;
  duplicate: (node: TreeNode) => void;
  remove: (node: TreeNode) => void;
  wrapInContainer: (node: TreeNode) => void;
  reorder: (draggedUid: string, targetUid: string) => void;
  openInIde: (node: TreeNode) => void;
}

export function useNodeOps(): NodeOps {
  const { sendOp } = useDaemonConnection();
  const fileFolder = useWorkspaceStore((s) => s.fileFolder);
  const setClipboard = useWorkspaceStore((s) => s.setClipboard);
  const clipboardUid = useWorkspaceStore((s) => s.clipboardUid);
  const currentTree = useWorkspaceStore((s) => s.currentTree);

  return React.useMemo<NodeOps>(
    () => ({
      copy(node) {
        setClipboard(node.uid);
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(JSON.stringify({ ccsClipboardUid: node.uid, tag: node.tag }));
        }
      },
      paste(node) {
        if (!clipboardUid) return;
        const tree = currentTree();
        if (!tree) return;
        // find the copied node's own tag (best-effort clone, see module doc)
        function find(n: TreeNode): TreeNode | null {
          if (n.uid === clipboardUid) return n;
          for (const c of n.children) {
            const found = find(c);
            if (found) return found;
          }
          return null;
        }
        const source = find(tree);
        sendOp({
          t: 'insert-node',
          parentUid: node.uid,
          index: node.children.length,
          source: { kind: 'element', tag: source?.tag ?? 'div' },
        });
      },
      duplicate(node) {
        const tree = currentTree();
        if (!tree) return;
        const parentInfo = findParent(tree, node.uid);
        if (!parentInfo) return; // root has no parent to duplicate within
        sendOp({
          t: 'insert-node',
          parentUid: parentInfo.parent.uid,
          index: parentInfo.index + 1,
          source: { kind: 'element', tag: node.tag ?? 'div' },
        });
      },
      remove(node) {
        sendOp({ t: 'delete-node', uid: node.uid });
      },
      wrapInContainer(node) {
        sendOp({ t: 'wrap-node', uids: [node.uid], wrapper: { tag: 'div', classes: 'flex flex-col gap-2' } });
      },
      reorder(draggedUid, targetUid) {
        if (!isNodeUid(draggedUid)) return;
        const tree = currentTree();
        if (!tree) return;
        const targetInfo = findParent(tree, targetUid);
        if (!targetInfo) return;
        sendOp({ t: 'move-node', uid: draggedUid, newParentUid: targetInfo.parent.uid, index: targetInfo.index });
      },
      openInIde(node) {
        if (!fileFolder) return;
        const relPath = node.uid.split(':')[0];
        // CR (best-effort deep link): the browser has no way to learn the
        // monorepo's absolute filesystem path, so this is project-relative,
        // not the absolute path `vscode://file/` technically expects — see
        // module doc.
        const href = `vscode://file/files/${fileFolder}/${relPath}`;
        window.open(href, '_self');
      },
    }),
    [sendOp, fileFolder, clipboardUid, setClipboard, currentTree],
  );
}
