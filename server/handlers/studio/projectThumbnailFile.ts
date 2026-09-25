/**
 * projectThumbnailFile — where a project's launcher preview lives on disk, and
 * how to ask whether it is there.
 *
 * A leaf on purpose. `studioProjectSummary` (`../studioProjects.ts`) has to
 * report whether a project HAS a thumbnail on every launcher render, and the
 * module that PRODUCES one (`./projectThumbnail.ts`) pulls in `sharp` and the
 * whole headless-capture chain. Splitting the two-line file model out keeps
 * the listing — the hottest read path in the launcher — from importing a
 * browser driver to answer "does this file exist".
 *
 * The image is Studio state about the user's project, so it goes in the
 * project's own `.studio/` sidecar beside `boards.json` and `framework.json`,
 * not in a server-side cache directory: a project that is copied, moved, or
 * restored from the trash carries its preview with it, and nothing has to
 * reconcile a cache keyed by a path that just changed.
 */
import type { Stats } from 'node:fs'
import { readStudioStoreBytes, statStudioStoreFile, studioStorePath, writeStudioStoreFile } from './studioStore'

/**
 * Thumbnail geometry: 4:3, 480px wide. The card renders it at roughly
 * 240–320 CSS px, so 480 is a 1.5–2× source that stays sharp on a HiDPI
 * display without storing a screenshot-sized PNG per project.
 */
export const PROJECT_THUMBNAIL_WIDTH = 480
export const PROJECT_THUMBNAIL_HEIGHT = 360

const THUMBNAIL_FILE = 'thumbnail.png'

/** `<dir>/.studio/thumbnail.png` — for a caller that must NAME it; reading and writing go through the functions below. */
export function projectThumbnailFile(dir: string): string {
  return studioStorePath(dir, THUMBNAIL_FILE)
}

/** What the HTTP layer needs to answer a conditional GET, and the listing needs to answer "is there one". */
export interface ProjectThumbnailStat {
  /** Epoch ms of the file's mtime — the version the card cache-busts on and the route's `Last-Modified`. */
  mtimeMs: number
  /** Byte length, the other half of the ETag. */
  size: number
}

function toThumbnailStat(stat: Stats | null): ProjectThumbnailStat | null {
  return stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
}

/**
 * The thumbnail's stat, or `null` when there isn't one. Never throws: a
 * launcher listing must not fail because one project's sidecar is unreadable.
 * A thumbnail reached through a link is not one (`studioStore.ts`): the route
 * would otherwise serve whatever file a cloned repository pointed it at.
 */
export function readProjectThumbnailStat(dir: string): ProjectThumbnailStat | null {
  try {
    return toThumbnailStat(statStudioStoreFile(dir, THUMBNAIL_FILE))
  } catch {
    return null
  }
}

/** The thumbnail's bytes, or `null` (absent, unreadable, or reached through a link). */
export function readProjectThumbnailBytes(dir: string): Buffer | null {
  return readStudioStoreBytes(dir, THUMBNAIL_FILE)
}

/** Replace the thumbnail in one step. Throws `StudioStoreLinkError` rather than write through a link. */
export function writeProjectThumbnail(dir: string, png: Uint8Array): ProjectThumbnailStat {
  writeStudioStoreFile(dir, THUMBNAIL_FILE, png)
  const stat = readProjectThumbnailStat(dir)
  if (!stat) throw new Error('The thumbnail was written but cannot be read back.')
  return stat
}
