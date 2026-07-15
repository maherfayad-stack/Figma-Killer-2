import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { join } from 'node:path';
import type { DaemonEvent } from '@ccs/protocol';
import { toProjectRelative } from './paths.js';
import type { SelfWriteTracker } from './self-write-tracker.js';

/**
 * FS watching (chokidar) — playbook §4/P1 step 5:
 *  - each file-folder's `src/frames/` (add/remove `.tsx` → event so the
 *    canvas can add/remove frames; edits → HMR-relevant event)
 *  - each file-folder's `.studio/canvas.json` (external geometry change →
 *    event)
 *  - the project's `design-system/**` (→ `tokens-changed`/
 *    `components-changed`, broadcast only in P1 — consumers land in P4)
 *
 * All emitted `file` paths are relative to the PROJECT root (not the
 * file-folder root) — see the module doc in `daemon.ts` for why a
 * daemon-level path convention has to differ from `FrameMeta.framePath`'s
 * file-folder-relative one.
 */

export interface WatchHandle {
  close(): Promise<void>;
}

const AWAIT_WRITE_FINISH = { stabilityThreshold: 50, pollInterval: 20 } as const;

/**
 * Watch one file-folder's `src/frames/` directory. Frame files being
 * added or removed is a structural change (canvas must add/remove a
 * frame); an edit to an existing frame's content is what actually drives
 * Vite HMR. The frozen `DaemonEvent` union (Appendix B ∪ §4/P0 prose) has
 * no dedicated "frame-added"/"frame-removed" variant, so both are surfaced
 * as `file-changed` (generic "something at this path changed" signal);
 * in-place edits additionally get `hmr-update` since that's specifically
 * when Vite's own HMR pipeline fires. See sync-daemon CHANGE-REQUEST notes
 * for why a future ADR might want dedicated variants.
 */
export function watchFrameFiles(
  projectRoot: string,
  fileFolderRoot: string,
  emit: (event: DaemonEvent) => void,
  /** P3 self-write suppression (ADR-0013 carry-forward, `self-write-
   * tracker.ts`): when provided, an in-place edit whose path was just
   * written by the daemon's own op-apply/undo/redo path is swallowed
   * here instead of re-broadcast — that write-through path already emits
   * its own `file-changed`/`hmr-update` (paired with `uid-remap`), so
   * without this every canvas op would double-fire the pair once
   * explicitly and once via this watcher rediscovering the same change a
   * `stabilityThreshold` later. Optional (defaults to no suppression) so
   * every pre-P3 caller/test keeps its exact original behavior. */
  selfWriteTracker?: SelfWriteTracker,
): WatchHandle {
  const framesDir = join(fileFolderRoot, 'src', 'frames');
  const watcher: FSWatcher = chokidarWatch(framesDir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: AWAIT_WRITE_FINISH,
  });

  const onStructural = (path: string) => {
    emit({ t: 'file-changed', file: toProjectRelative(projectRoot, path) });
  };
  const onEdit = (path: string) => {
    if (selfWriteTracker?.consume(path)) return;
    const file = toProjectRelative(projectRoot, path);
    emit({ t: 'file-changed', file });
    emit({ t: 'hmr-update', file });
  };

  watcher.on('add', onStructural);
  watcher.on('unlink', onStructural);
  watcher.on('change', onEdit);

  return { close: () => watcher.close() };
}

/** Watch one file-folder's `.studio/canvas.json` for edits made outside
 * the daemon's own geometry-write API (e.g. hand-editing the file, or a
 * future tool). */
export function watchCanvasJson(
  projectRoot: string,
  fileFolderRoot: string,
  emit: (event: DaemonEvent) => void,
): WatchHandle {
  const canvasJsonPath = join(fileFolderRoot, '.studio', 'canvas.json');
  const watcher: FSWatcher = chokidarWatch(canvasJsonPath, {
    ignoreInitial: true,
    awaitWriteFinish: AWAIT_WRITE_FINISH,
  });

  watcher.on('add', () => emit({ t: 'file-changed', file: toProjectRelative(projectRoot, canvasJsonPath) }));
  watcher.on('change', () =>
    emit({ t: 'file-changed', file: toProjectRelative(projectRoot, canvasJsonPath) }),
  );

  return { close: () => watcher.close() };
}

/**
 * Watch the project's `design-system/**` (ADR-0006/ADR-0008: the real
 * Almosafer DS at `./design-system` when this daemon's projectRoot is the
 * studio monorepo root). Read-only observation — this module never writes
 * into `design-system/` (BOUNDARIES: "Do NOT touch ./design-system/").
 * P1 scope is broadcast-only; P4 lands actual consumers (tokens/components
 * rebuild pipeline).
 */
export function watchDesignSystem(
  projectRoot: string,
  emit: (event: DaemonEvent) => void,
): WatchHandle {
  const designSystemDir = join(projectRoot, 'design-system');
  const watcher: FSWatcher = chokidarWatch(designSystemDir, {
    ignoreInitial: true,
    awaitWriteFinish: AWAIT_WRITE_FINISH,
  });

  watcher.on('all', (_event, path) => {
    if (!path) return;
    const rel = toProjectRelative(projectRoot, path).toLowerCase();
    const touchesTokens = rel.includes('token');
    const touchesComponents = rel.includes('component');
    // Heuristic split by path segment; if neither keyword is present
    // (e.g. a top-level index/readme change) broadcast both — P1 has no
    // consumers yet so over-broadcasting is harmless (playbook step 5:
    // "broadcast only in P1").
    if (touchesTokens || !touchesComponents) emit({ t: 'tokens-changed' });
    if (touchesComponents || !touchesTokens) emit({ t: 'components-changed' });
  });

  return { close: () => watcher.close() };
}
