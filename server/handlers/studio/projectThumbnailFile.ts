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
import { statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Thumbnail geometry: 4:3, 480px wide. The card renders it at roughly
 * 240–320 CSS px, so 480 is a 1.5–2× source that stays sharp on a HiDPI
 * display without storing a screenshot-sized PNG per project.
 */
export const PROJECT_THUMBNAIL_WIDTH = 480
export const PROJECT_THUMBNAIL_HEIGHT = 360

/** `<dir>/.studio/thumbnail.png` — the one path both the writer and the route use. */
export function projectThumbnailFile(dir: string): string {
  return join(dir, '.studio', 'thumbnail.png')
}

/** What the HTTP layer needs to answer a conditional GET, and the listing needs to answer "is there one". */
export interface ProjectThumbnailStat {
  /** Epoch ms of the file's mtime — the version the card cache-busts on and the route's `Last-Modified`. */
  mtimeMs: number
  /** Byte length, the other half of the ETag. */
  size: number
}

/**
 * The thumbnail's stat, or `null` when there isn't one. Never throws: a
 * launcher listing must not fail because one project's sidecar is unreadable.
 */
export function readProjectThumbnailStat(dir: string): ProjectThumbnailStat | null {
  try {
    const stat = statSync(projectThumbnailFile(dir))
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
  } catch {
    return null
  }
}
