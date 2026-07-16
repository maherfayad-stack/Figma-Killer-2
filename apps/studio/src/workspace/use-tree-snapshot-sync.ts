import * as React from 'react';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useWorkspaceStore } from './workspace-store.js';

/**
 * P5 RESUME item 2 (STATE.md "P5 RESUME HERE"): wires the studio-chrome
 * control-ws connection's `tree-snapshot` `DaemonEvent`s into
 * `workspace-store`'s live `trees` map, replacing the P5-WIP mock-fixture
 * lookup (`tree-fixtures.ts`'s doc). Kept as its own tiny hook rather than
 * folding the subscription into `daemon-connection.tsx` directly, so the
 * engine layer (`daemon-connection.tsx`) stays workspace-store-agnostic —
 * same layering `PagesPanel`/`Inspector` already use (they call
 * `useDaemonConnection()` and `useWorkspaceStore()` side by side, never
 * from inside `daemon-connection.tsx` itself).
 *
 * `event.file` is FILE-FOLDER-relative (ADR-0018 item 5 precedent, see
 * `packages/sync-daemon/src/paths.ts` `toFileFolderRelative`'s doc) — the
 * SAME convention `workspace-store.framePath` already uses (set via
 * `selectFrame(fileFolder, framePath)`, itself sourced from
 * `daemon-connection.tsx`'s already-file-folder-relative `FrameSummary`),
 * so no path translation is needed here; `currentTree()` looks the tree up
 * by `framePath` directly against this same key.
 */
export function useTreeSnapshotSync(): void {
  const { onEvent } = useDaemonConnection();
  const setTreeSnapshot = useWorkspaceStore((s) => s.setTreeSnapshot);

  React.useEffect(() => {
    return onEvent((event) => {
      if (event.t !== 'tree-snapshot') return;
      setTreeSnapshot(event.file, event.tree);
    });
  }, [onEvent, setTreeSnapshot]);
}
