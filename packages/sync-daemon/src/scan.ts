import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A single frame: one `.tsx` file under a file-folder's `src/frames/`
 * (playbook §4/P1: "each `src/frames/*.tsx` is a frame").
 */
export interface FrameFile {
  /** Filename without extension, e.g. "Hero". Used as `?frame=<Name>`. */
  name: string;
  /** Path relative to the file-folder root, e.g. "src/frames/Hero.tsx".
   * Matches `FrameEntry.framePath` in `.studio/canvas.json` exactly. */
  framePath: string;
  /** Absolute path on disk. */
  absPath: string;
}

/** One "file" — a Penpot-style file-folder under `files/<name>/`, served by
 * its own Vite dev server (playbook §4/P1: "one Vite server per
 * file-folder, NOT per frame"). */
export interface FileFolder {
  /** Directory name under `files/`, e.g. "demo". */
  name: string;
  /** Absolute path to the file-folder root. */
  root: string;
  frames: FrameFile[];
}

const TSX_EXTENSION = '.tsx';

/**
 * Scan `<projectRoot>/files/*\/src/frames/*.tsx` (playbook §4/P1 step 1).
 * File-folders with no `src/frames` directory yet, or an empty one, are
 * still returned (with `frames: []`) so the daemon can still track/boot
 * them once frames are added.
 */
export async function scanProject(projectRoot: string): Promise<FileFolder[]> {
  const filesDir = join(projectRoot, 'files');
  const topEntries = await safeReadDir(filesDir);
  const fileFolders: FileFolder[] = [];

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const root = join(filesDir, entry.name);
    const frames = await scanFrames(root);
    fileFolders.push({ name: entry.name, root, frames });
  }

  // Stable, deterministic ordering (readdir order isn't guaranteed on all
  // platforms) — daemon relies on this for reproducible port assignment.
  fileFolders.sort((a, b) => a.name.localeCompare(b.name));
  return fileFolders;
}

async function scanFrames(fileFolderRoot: string): Promise<FrameFile[]> {
  const framesDir = join(fileFolderRoot, 'src', 'frames');
  const entries = await safeReadDir(framesDir);
  const frames: FrameFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(TSX_EXTENSION)) continue;
    const name = entry.name.slice(0, -TSX_EXTENSION.length);
    if (name.length === 0) continue;
    frames.push({
      name,
      framePath: `src/frames/${entry.name}`,
      absPath: join(framesDir, entry.name),
    });
  }

  frames.sort((a, b) => a.name.localeCompare(b.name));
  return frames;
}

async function safeReadDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
