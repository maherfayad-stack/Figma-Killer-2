import { relative, sep } from 'node:path';

function toRelativePosix(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}

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
  return toRelativePosix(projectRoot, absPath);
}

/**
 * File-folder-relative conversion — the convention `FrameEntry.framePath`
 * and every `NodeUid`'s embedded relPath half already use (ADR-0012/0013).
 * `UidRemapEvent.file` was ratified onto this same convention (ADR-0018
 * item 5: "file-folder-relative — matches NodeUid's embedded relPath") over
 * the daemon's usual project-relative wire convention, precisely because
 * that event's payload carries/derives from a NodeUid. `TreeSnapshotEvent`
 * (P5, `tree-snapshot.ts`) is the same shape of exception: every uid inside
 * the emitted `TreeNode` embeds a file-folder-relative relPath, so `file`
 * follows suit for the identical reason — a client can match a `tree-
 * snapshot`'s `file` directly against `NodeUid`'s relPath half (and against
 * `workspace-store`'s file-folder-relative `framePath`) without needing the
 * file-folder segment stripped first.
 */
export function toFileFolderRelative(fileFolderRoot: string, absPath: string): string {
  return toRelativePosix(fileFolderRoot, absPath);
}
