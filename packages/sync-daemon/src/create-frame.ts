import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCanvasJson, writeCanvasJsonAtomic } from './canvas-json.js';
import {
  buildFrameSource,
  buildNewCanvasJsonEntry,
  frameSourcePath,
  isValidFrameName,
  patchFramesRegistry,
} from './new-frame.js';

/**
 * `create-frame` fs orchestration (ADR-0014) — ported from
 * `packages/canvas/dev/create-frame-server.ts`'s `createFrameOnDisk` (see
 * that file's module doc for the original dev-harness-only version this
 * closely mirrors). Writes the three artifacts a new frame touches, in the
 * same order for the same reason: source file, then registry, then
 * `.studio/canvas.json` last — canvas.json's resulting `file-changed` is
 * what a client treats as authoritative for geometry, so it should land
 * only once the frame is actually renderable.
 *
 * Callers (daemon.ts) are responsible for running this inside the
 * `FileOpQueue` keyed per file-folder so concurrent create-frame calls (or
 * a create-frame racing a future AST op) against the same file-folder never
 * interleave their reads/writes.
 */

export interface CreateFrameResult {
  /** File-folder-relative, e.g. "src/frames/Testimonials.tsx" — matches
   * `FrameEntry.framePath` exactly. */
  framePath: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new frame inside `fileFolderRoot` (an already-resolved,
 * known-good file-folder root — callers must resolve `fileFolder` names
 * against the daemon's own file-folder list *before* calling this, so a
 * bogus/unknown fileFolder name is rejected at that lookup and never
 * reaches a path join here).
 *
 * Rejects with a plain `Error` (never throws anything else) for:
 *  - an invalid name (`isValidFrameName` — also the path-traversal guard:
 *    no `/`, `.`, or whitespace can pass it, so `name` can never escape
 *    `src/frames/`),
 *  - a frame that already exists on disk at the target path,
 *  - a frame already registered in `src/frames.ts` (checked by
 *    `patchFramesRegistry`, which also validates the registry's shape).
 */
export async function createFrameOnDisk(fileFolderRoot: string, name: string): Promise<CreateFrameResult> {
  if (!isValidFrameName(name)) {
    throw new Error(`invalid frame name "${name}" — must be PascalCase (e.g. "Testimonials")`);
  }

  const relPath = frameSourcePath(name);
  const absSourcePath = join(fileFolderRoot, relPath);
  const framesRegistryPath = join(fileFolderRoot, 'src', 'frames.ts');

  if (await pathExists(absSourcePath)) {
    throw new Error(`frame "${name}" already exists at ${relPath}`);
  }

  const registrySource = await readFile(framesRegistryPath, 'utf8');
  const patchedRegistry = patchFramesRegistry(registrySource, name); // throws if already registered

  const meta = await readCanvasJson(fileFolderRoot);
  const newEntry = buildNewCanvasJsonEntry(meta.frames, name);

  await writeFile(absSourcePath, buildFrameSource(name), 'utf8');
  await writeFile(framesRegistryPath, patchedRegistry, 'utf8');
  await writeCanvasJsonAtomic(fileFolderRoot, { ...meta, frames: [...meta.frames, newEntry] });

  return { framePath: relPath };
}
