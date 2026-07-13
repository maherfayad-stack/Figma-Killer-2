import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FrameMetaSchema, type FrameEntry, type FrameMeta } from '@ccs/protocol';
import type { FrameFile } from './scan.js';

/**
 * `.studio/canvas.json` read/write, validated against the frozen `FrameMeta`
 * schema (playbook §4/P1 step 1 + §0 corollary: "the only editor-owned
 * persistent data ... stored in `.studio/canvas.json`"). This module is the
 * ONLY place in the daemon that persists anything to disk on the daemon's
 * own initiative (geometry writes go through the same functions — see
 * geometry.ts).
 */

const CANVAS_JSON_RELATIVE = join('.studio', 'canvas.json');

const EMPTY_META: FrameMeta = { frames: [], comments: [], zoomBookmarks: [] };

/**
 * Read and validate a file-folder's `.studio/canvas.json`. A missing file
 * is NOT an error — a freshly scaffolded file-folder has none yet — it
 * resolves to an empty, valid `FrameMeta`. A present-but-invalid file
 * (fails the frozen schema) throws, deliberately: silently coercing
 * corrupt spatial metadata would violate the "no second scene model"
 * discipline (playbook §5 Global Risk #1) by inventing data.
 */
export async function readCanvasJson(fileFolderRoot: string): Promise<FrameMeta> {
  const file = join(fileFolderRoot, CANVAS_JSON_RELATIVE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_META;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`@ccs/sync-daemon: ${file} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const result = FrameMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `@ccs/sync-daemon: ${file} failed FrameMeta validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Validate + atomically write a file-folder's `.studio/canvas.json`
 * (write to a temp file in the same directory, then rename — atomic on
 * POSIX filesystems, avoids readers ever observing a half-written file).
 */
export async function writeCanvasJsonAtomic(
  fileFolderRoot: string,
  meta: FrameMeta,
): Promise<void> {
  const validated = FrameMetaSchema.parse(meta); // never write data that fails the frozen schema
  const dir = join(fileFolderRoot, '.studio');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'canvas.json');
  const tmp = join(dir, `.canvas.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, JSON.stringify(validated, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

const DEFAULT_FRAME_WIDTH = 1440;
const DEFAULT_FRAME_HEIGHT = 900;
const DEFAULT_FRAME_GAP = 160;

function defaultFrameEntry(framePath: string, index: number): FrameEntry {
  return {
    framePath,
    x: index * (DEFAULT_FRAME_WIDTH + DEFAULT_FRAME_GAP),
    y: 0,
    w: DEFAULT_FRAME_WIDTH,
    h: DEFAULT_FRAME_HEIGHT,
  };
}

/**
 * Reconcile `.studio/canvas.json`'s `frames[]` against what's actually on
 * disk under `src/frames/` (playbook §4/P1 step 5: "add/remove `.tsx` →
 * event so canvas can add/remove frames"):
 *  - a discovered frame with no existing entry gets a fresh default-
 *    positioned entry appended (cascading grid, matches the template
 *    fixture's spacing convention).
 *  - an existing entry whose `framePath` no longer exists on disk is
 *    dropped (its frame file was deleted).
 * `comments`/`zoomBookmarks` are passed through untouched.
 */
export function syncFrameEntries(meta: FrameMeta, frames: readonly FrameFile[]): FrameMeta {
  const discoveredPaths = new Set(frames.map((f) => f.framePath));
  const existingPaths = new Set(meta.frames.map((f) => f.framePath));

  const kept = meta.frames.filter((f) => discoveredPaths.has(f.framePath));
  const newlyDiscovered = frames.filter((f) => !existingPaths.has(f.framePath));
  const added = newlyDiscovered.map((f, i) => defaultFrameEntry(f.framePath, kept.length + i));

  return { ...meta, frames: [...kept, ...added] };
}

/** Structural equality good enough for "did syncFrameEntries actually
 * change anything" — avoids a redundant disk write when nothing moved. */
export function frameMetaEquals(a: FrameMeta, b: FrameMeta): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Convenience: read-or-default, then reconcile against disk, writing back
 * only if something changed. Returns the reconciled (and now-persisted)
 * `FrameMeta`. Used by the daemon on project open. */
export async function reconcileCanvasJson(
  fileFolderRoot: string,
  frames: readonly FrameFile[],
): Promise<FrameMeta> {
  const current = await readCanvasJson(fileFolderRoot);
  const reconciled = syncFrameEntries(current, frames);
  if (!frameMetaEquals(current, reconciled)) {
    await writeCanvasJsonAtomic(fileFolderRoot, reconciled);
  }
  return reconciled;
}
