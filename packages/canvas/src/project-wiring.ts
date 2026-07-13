import type { FrameMeta } from '@ccs/protocol';
import type { ProjectInfo } from '@ccs/protocol';
import { deriveFileFolderPath } from './daemon-protocol.js';
import { type Box } from './geometry.js';

/**
 * ProjectInfo (+ each file-folder's `.studio/canvas.json`) → the flat list
 * of frame records `StudioCanvas` renders as tldraw `FrameShape`s. Pure and
 * framework-free — this is the exact seam the DoD's "ProjectInfo→FrameShape
 * wiring" unit tests target; `StudioCanvas.tsx` only adapts this output
 * into tldraw shape records.
 */
export interface CanvasFrameRecord {
  /** Stable id across HMR/reconnects: `${fileFolder}::${framePath}`. */
  id: string;
  fileFolder: string;
  /** File-folder-relative, matches `FrameEntry.framePath` exactly. */
  framePath: string;
  /** Filename without extension, e.g. "Hero". */
  name: string;
  /** Full iframe src, already including `?frame=<Name>` (ADR-0012/0013). */
  devServerUrl: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function frameRecordId(fileFolder: string, framePath: string): string {
  return `${fileFolder}::${framePath}`;
}

/** Cascading-grid default geometry, re-derived independently from (not
 * imported from) `@ccs/sync-daemon`'s internal `defaultFrameEntry` —
 * that helper isn't part of the daemon's public `index.ts` surface
 * (BOUNDARIES: canvas must not reach into sync-daemon internals). Same
 * constants, so a frame that hasn't round-tripped through the daemon's
 * own reconciliation yet still lands in the same visual convention. */
const DEFAULT_FRAME_WIDTH = 1440;
const DEFAULT_FRAME_HEIGHT = 900;
const DEFAULT_FRAME_GAP = 160;

export function defaultGeometryForIndex(index: number): Box {
  return {
    x: index * (DEFAULT_FRAME_WIDTH + DEFAULT_FRAME_GAP),
    y: 0,
    w: DEFAULT_FRAME_WIDTH,
    h: DEFAULT_FRAME_HEIGHT,
  };
}

/**
 * Build the initial `CanvasFrameRecord[]` from the daemon's bootstrap
 * `ProjectInfo` plus each referenced file-folder's already-fetched
 * `FrameMeta` (via `fetchCanvasJson`, keyed by file-folder name). A frame
 * with no matching `FrameEntry` (canvas.json not yet reconciled, or fetch
 * failed) gets a deterministic cascading default so it still renders
 * somewhere sane instead of being dropped.
 */
export function wireProjectInfo(
  info: ProjectInfo,
  canvasJsonByFileFolder: ReadonlyMap<string, FrameMeta>,
): CanvasFrameRecord[] {
  const records: CanvasFrameRecord[] = [];
  const fallbackIndexByFileFolder = new Map<string, number>();

  for (const frame of info.frames) {
    const derived = deriveFileFolderPath(frame.framePath);
    if (!derived) continue;
    const { fileFolder, relPath } = derived;

    const meta = canvasJsonByFileFolder.get(fileFolder);
    const entry = meta?.frames.find((f) => f.framePath === relPath);

    const box = entry
      ? { x: entry.x, y: entry.y, w: entry.w, h: entry.h }
      : defaultGeometryForIndex(fallbackIndexByFileFolder.get(fileFolder) ?? 0);
    if (!entry) fallbackIndexByFileFolder.set(fileFolder, (fallbackIndexByFileFolder.get(fileFolder) ?? 0) + 1);

    records.push({
      id: frameRecordId(fileFolder, relPath),
      fileFolder,
      framePath: relPath,
      name: frame.name,
      devServerUrl: frame.devServerUrl,
      ...box,
    });
  }

  return records;
}

/** Add-or-replace a record by id (used when a new frame is discovered, or
 * an existing one's geometry/URL needs refreshing). */
export function upsertFrameRecord(
  records: readonly CanvasFrameRecord[],
  next: CanvasFrameRecord,
): CanvasFrameRecord[] {
  const idx = records.findIndex((r) => r.id === next.id);
  if (idx === -1) return [...records, next];
  return records.map((r, i) => (i === idx ? next : r));
}

export function removeFrameRecord(
  records: readonly CanvasFrameRecord[],
  id: string,
): CanvasFrameRecord[] {
  return records.filter((r) => r.id !== id);
}

/** Apply a fresh geometry read (e.g. after a `file-changed` on
 * `.studio/canvas.json`) to every record in `fileFolder`, matching by
 * `framePath`. Records with no corresponding `FrameEntry` are left
 * untouched (their existing geometry — possibly a local optimistic drag —
 * is preserved rather than snapped to a fallback default). */
export function resyncFileFolderGeometry(
  records: readonly CanvasFrameRecord[],
  fileFolder: string,
  meta: FrameMeta,
): CanvasFrameRecord[] {
  return records.map((r) => {
    if (r.fileFolder !== fileFolder) return r;
    const entry = meta.frames.find((f) => f.framePath === r.framePath);
    if (!entry) return r;
    return { ...r, x: entry.x, y: entry.y, w: entry.w, h: entry.h };
  });
}
