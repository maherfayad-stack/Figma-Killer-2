import * as React from 'react';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useEngineApi } from '../engine/engine-api-context.js';
import { childUid } from '../engine/tree-nav.js';
import { useWorkspaceStore } from './workspace-store.js';

/**
 * Shared "insert a design-system component" action — used by both
 * `ComponentsPanel`'s Insert button and the canvas-area drop zone (playbook
 * §4/P5: "drag component onto frame -> `insert-node` op with import").
 * See `ComponentsPanel.tsx`'s module doc for the uid-prediction CR this
 * shares.
 */
export function useComponentInsert(): (name: string) => void {
  const { sendOp } = useDaemonConnection();
  const engine = useEngineApi();
  const currentTree = useWorkspaceStore((s) => s.currentTree);
  const selectedNode = useWorkspaceStore((s) => s.selectedNode);

  return React.useCallback(
    (name: string) => {
      const tree = currentTree();
      if (!tree) return;
      const target = selectedNode() ?? tree;
      const index = target.children.length;
      sendOp({ t: 'insert-node', parentUid: target.uid, index, source: { kind: 'ds-component', name } });

      const schema = engine.getPropSchema(name);
      if (!schema) return;
      const newUid = childUid(target.uid, index);
      for (const [propName, entry] of Object.entries(schema.props)) {
        if (entry.required && entry.default !== undefined) {
          sendOp({ t: 'set-prop', uid: newUid, name: propName, value: entry.default });
        }
      }
    },
    [sendOp, engine, currentTree, selectedNode],
  );
}
