import { relative, sep } from 'node:path';

/**
 * Every path this daemon surfaces over the wire (DaemonEvent.file,
 * ProjectInfo.framePath) is relative to the PROJECT root and uses forward
 * slashes, regardless of platform — a single daemon manages multiple
 * file-folders, so a project-root-relative, OS-independent path is the
 * only unambiguous, portable choice. (Contrast with `FrameEntry.framePath`
 * inside a single file-folder's `.studio/canvas.json`, which stays
 * relative to that file-folder per the already-frozen `FrameMeta` schema.)
 */
export function toProjectRelative(projectRoot: string, absPath: string): string {
  return relative(projectRoot, absPath).split(sep).join('/');
}
