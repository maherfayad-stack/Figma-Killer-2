import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCanvasJson, writeCanvasJsonAtomic } from './canvas-json.js';
import { frameSourcePath, isValidFrameName, patchFramesRegistry } from './new-frame.js';

/**
 * `duplicate-frame` fs orchestration (ADR-0015 — the P1 defect fix: tldraw's
 * built-in duplicate/copy/paste created `ccs-frame` canvas shapes with no
 * backing `.tsx`, which the frames→shape reaper in `StudioCanvas.tsx` then
 * deleted on the next sync). This module makes duplication REAL: it copies
 * the source `.tsx` file's content into a new, uniquely-named frame file,
 * patches `src/frames.ts`, and appends a `.studio/canvas.json` entry offset
 * +40/+40 from the source — the same three-artifact shape `create-frame.ts`
 * writes (source, then registry, then canvas.json last, for the same
 * reason: canvas.json's `file-changed` is what a client treats as
 * authoritative for a new frame's geometry, so it should land only once the
 * frame is actually renderable).
 *
 * Callers (daemon.ts) MUST run this inside the same per-file-folder
 * `FileOpQueue` key `create-frame.ts` uses (`src/frames.ts`'s absolute
 * path) — serializing on the one artifact both a `create-frame` and a
 * `duplicate-frame` call mutate, so the two request kinds can never
 * interleave their registry reads/writes against the same file-folder.
 *
 * Decision taken alone (component-identifier handling): the new file's
 * content is a PURE, byte-for-byte copy of the source — the internal
 * `export default function <Name>()` identifier is deliberately NOT
 * renamed to match the new filename. `src/frames.ts` always imports a
 * frame's default export under a LOCAL binding named after the file
 * (`import HeroCopy from './frames/HeroCopy.js'`), so the internal function
 * name never has to match the filename for the app to run correctly (this
 * was verified against `new-frame.ts`'s own `buildFrameSource`/
 * `patchFramesRegistry` pair — the registry keys off the import binding,
 * never the function's own name). Renaming the identifier would be a
 * cosmetic nicety, not a functional requirement, and it would turn this
 * from a content-preserving copy into a mini codemod outside this module's
 * IO-free-builder-reuse scope (playbook §0: that's ast-engine's job, P3).
 */

export interface DuplicateFrameResult {
  /** The unique name the daemon picked (or the caller's accepted hint). */
  newName: string;
  /** File-folder-relative, e.g. "src/frames/HeroCopy.tsx". */
  framePath: string;
}

const DUPLICATE_OFFSET = 40;
const DEFAULT_FRAME_WIDTH = 1440;
const DEFAULT_FRAME_HEIGHT = 900;
/** Bound on the `<sourceName>Copy`/`Copy2`/… search so a pathological
 * file-folder (thousands of pre-existing copies) fails loudly instead of
 * looping forever. */
const MAX_UNIQUE_NAME_ATTEMPTS = 1000;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks `<sourceName>Copy`, then `<sourceName>Copy2`, `Copy3`, … — the
 * first candidate whose source file does not already exist on disk
 * (playbook task brief: "never colliding"). Disk existence is the ground
 * truth here (same discipline `createFrameOnDisk` uses): a file-folder
 * whose `src/frames.ts`/`canvas.json` disagree with what's actually on
 * disk is already an inconsistency `patchFramesRegistry`'s own "refuse
 * rather than guess" check will surface as a `control-error`, not
 * something this function should paper over.
 */
async function pickUniqueName(fileFolderRoot: string, sourceName: string): Promise<string> {
  for (let n = 0; n < MAX_UNIQUE_NAME_ATTEMPTS; n++) {
    const candidate = n === 0 ? `${sourceName}Copy` : `${sourceName}Copy${n + 1}`;
    if (!(await pathExists(join(fileFolderRoot, frameSourcePath(candidate))))) {
      return candidate;
    }
  }
  throw new Error(
    `@ccs/sync-daemon: could not find a unique name for a copy of "${sourceName}" after ${MAX_UNIQUE_NAME_ATTEMPTS} attempts`,
  );
}

/**
 * Duplicate `sourceName`'s frame inside `fileFolderRoot` (an
 * already-resolved, known-good file-folder root — same caller contract as
 * `createFrameOnDisk`). Rejects with a plain `Error` for:
 *  - an invalid `sourceName`/`requestedNewName` (`isValidFrameName` — also
 *    the path-traversal guard, same as `create-frame.ts`),
 *  - an unknown `sourceName` (no such `.tsx` on disk),
 *  - a `requestedNewName` that already exists on disk,
 *  - (via `patchFramesRegistry`) a resulting name already registered in
 *    `src/frames.ts` even though its file didn't exist yet — a
 *    registry/disk inconsistency, surfaced rather than silently resolved.
 */
export async function duplicateFrameOnDisk(
  fileFolderRoot: string,
  sourceName: string,
  requestedNewName?: string,
): Promise<DuplicateFrameResult> {
  if (!isValidFrameName(sourceName)) {
    throw new Error(`invalid source frame name "${sourceName}" — must be PascalCase (e.g. "Hero")`);
  }

  const sourceRelPath = frameSourcePath(sourceName);
  const absSourcePath = join(fileFolderRoot, sourceRelPath);
  if (!(await pathExists(absSourcePath))) {
    throw new Error(`unknown source frame "${sourceName}" (no ${sourceRelPath} on disk)`);
  }

  let newName: string;
  if (requestedNewName !== undefined) {
    if (!isValidFrameName(requestedNewName)) {
      throw new Error(`invalid new frame name "${requestedNewName}" — must be PascalCase (e.g. "HeroAlt")`);
    }
    if (await pathExists(join(fileFolderRoot, frameSourcePath(requestedNewName)))) {
      throw new Error(`frame "${requestedNewName}" already exists`);
    }
    newName = requestedNewName;
  } else {
    newName = await pickUniqueName(fileFolderRoot, sourceName);
  }

  const relPath = frameSourcePath(newName);
  const absNewPath = join(fileFolderRoot, relPath);
  const framesRegistryPath = join(fileFolderRoot, 'src', 'frames.ts');

  const sourceContent = await readFile(absSourcePath, 'utf8');
  const registrySource = await readFile(framesRegistryPath, 'utf8');
  const patchedRegistry = patchFramesRegistry(registrySource, newName); // throws if already registered

  const meta = await readCanvasJson(fileFolderRoot);
  const sourceEntry = meta.frames.find((f) => f.framePath === sourceRelPath);
  const newEntry = sourceEntry
    ? {
        framePath: relPath,
        x: sourceEntry.x + DUPLICATE_OFFSET,
        y: sourceEntry.y + DUPLICATE_OFFSET,
        w: sourceEntry.w,
        h: sourceEntry.h,
      }
    : { framePath: relPath, x: DUPLICATE_OFFSET, y: DUPLICATE_OFFSET, w: DEFAULT_FRAME_WIDTH, h: DEFAULT_FRAME_HEIGHT };

  // Same write ordering as createFrameOnDisk, for the same reason: source
  // file, then registry, then canvas.json last (its file-changed broadcast
  // is what a client treats as "the frame is real").
  await writeFile(absNewPath, sourceContent, 'utf8');
  await writeFile(framesRegistryPath, patchedRegistry, 'utf8');
  await writeCanvasJsonAtomic(fileFolderRoot, { ...meta, frames: [...meta.frames, newEntry] });

  return { newName, framePath: relPath };
}
