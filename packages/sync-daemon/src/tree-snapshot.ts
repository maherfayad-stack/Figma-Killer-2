import { readFile } from 'node:fs/promises';
import { buildTree } from '@ccs/ast-engine';
import type { TreeNode, TreeSnapshotEvent } from '@ccs/protocol';

/**
 * `tree-snapshot` emission (P5 resume item 1, STATE.md "P5 RESUME HERE";
 * ADR-0009's frozen `TreeNode` / `TreeSnapshotEventSchema`). Reads a
 * frame's CURRENT source off disk and builds its live `TreeNode` via
 * `@ccs/ast-engine`'s already-conformance-tested `buildTree` — the SAME
 * uid derivation `applyOp`'s resolver and the P2 babel plugin's `data-uid`
 * DOM attribute share (ADR-0017's golden conformance corpus), so every uid
 * in the resulting tree is byte-identical to what the bridge tags and what
 * a follow-up `CanvasOp` targeting that uid will resolve. `buildTree`
 * itself is pure/zero-IO (ast-engine discipline); this module is the ONE
 * place in the daemon that pairs it with the actual fs read, mirroring how
 * `op-apply.ts` is the one place that pairs `applyOp` with fs IO.
 */

/**
 * Reads + parses one frame file into a live `TreeNode`. Fails SOFT (returns
 * `null`) rather than throwing: a transient mid-save state, a frame briefly
 * emptied by an editor, or a file that no longer exists (deleted) should
 * never crash the daemon or spam an exception up through the fs watcher —
 * callers simply skip the broadcast for that one attempt and let the next
 * stable edit (or the next debounced retry) produce a good tree.
 */
export async function buildLiveTreeSnapshot(absFilePath: string, relPath: string): Promise<TreeNode | null> {
  let sourceText: string;
  try {
    sourceText = await readFile(absFilePath, 'utf8');
  } catch {
    return null;
  }
  try {
    return buildTree(sourceText, relPath);
  } catch {
    // e.g. no JSX root yet (file mid-edit / genuinely empty) — not a bug,
    // just "nothing to show yet"; the caller waits for the next event.
    return null;
  }
}

export interface TreeSnapshotStore {
  /**
   * Immediate (non-debounced) compute + cache — used once per known frame
   * at project-open, so a client that connects before any edit happens
   * still gets every frame's CURRENT tree via `currentEvents()` right
   * after the bootstrap `ProjectInfo` (mirrors how `ProjectInfo` itself
   * already carries full up-front state rather than requiring an edit to
   * discover it).
   */
  computeAndCache(absFilePath: string, relPath: string): Promise<TreeNode | null>;
  /**
   * Debounced recompute — collapses an HMR burst (a rapid run of
   * watcher/op-apply events against the SAME file) into exactly one
   * rebuild-and-broadcast after `debounceMs` of quiet, keyed per absolute
   * file path (same per-key debounce discipline as `geometry.ts`'s
   * `createGeometryWriter`).
   */
  scheduleRecompute(absFilePath: string, relPath: string): void;
  /** Every currently-cached tree, as ready-to-send `TreeSnapshotEvent`s —
   * replayed to each NEWLY connecting control-ws client (see `ws-server.ts`
   * `getInitialEvents`) so its LayersPanel has data before the next edit. */
  currentEvents(): TreeSnapshotEvent[];
  /** Cancels every pending debounce timer (daemon shutdown). */
  dispose(): void;
}

export interface TreeSnapshotStoreOptions {
  /** Called once a debounced recompute produces a fresh (non-null) tree —
   * the daemon wires this to `control.broadcast`. Never called for an
   * immediate `computeAndCache` (project-open population predates any
   * connected client, so there's nothing to broadcast to yet — those
   * frames surface via `currentEvents()` on each connection instead). */
  onRecomputed: (event: TreeSnapshotEvent) => void;
  /** Default 150ms — long enough to collapse a burst of rapid keystroke-
   * driven saves/HMR events into one rebuild, short enough that a
   * LayersPanel update still feels live. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 150;

export function createTreeSnapshotStore(options: TreeSnapshotStoreOptions): TreeSnapshotStore {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  /** Keyed by file-folder-relative relPath (matches `TreeSnapshotEvent.file`
   * — see `paths.ts` `toFileFolderRelative`'s doc for why this event
   * follows the uid-embedded-relPath convention rather than the daemon's
   * usual project-relative one). */
  const cache = new Map<string, TreeNode>();
  /** Keyed by absolute file path — debounce timers are per-file-on-disk,
   * independent of which relPath convention is used to report it. */
  const timers = new Map<string, NodeJS.Timeout>();

  async function computeAndCache(absFilePath: string, relPath: string): Promise<TreeNode | null> {
    const tree = await buildLiveTreeSnapshot(absFilePath, relPath);
    if (tree) cache.set(relPath, tree);
    else cache.delete(relPath); // stale entry (e.g. frame deleted) must not outlive the file
    return tree;
  }

  function scheduleRecompute(absFilePath: string, relPath: string): void {
    const existing = timers.get(absFilePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(absFilePath);
      void computeAndCache(absFilePath, relPath).then((tree) => {
        if (tree) options.onRecomputed({ t: 'tree-snapshot', file: relPath, tree });
      });
    }, debounceMs);
    timers.set(absFilePath, timer);
  }

  function currentEvents(): TreeSnapshotEvent[] {
    return [...cache.entries()].map(([file, tree]) => ({ t: 'tree-snapshot', file, tree }));
  }

  function dispose(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { computeAndCache, scheduleRecompute, currentEvents, dispose };
}
