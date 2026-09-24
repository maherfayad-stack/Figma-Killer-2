/**
 * canvasLayerFiles — the only code that touches a free-canvas layer module on
 * disk (P5-G, FC-1): `.studio/canvas/<id>.tsx`.
 *
 * `.studio/` is Studio's control plane, and every other Studio writer refuses
 * it (`@core/page-parser`'s `workspaceWriteScope.ts`). This module is the one
 * narrow door through that rule, so it is written to be boring and strict:
 *
 *  - **A path is only ever built from a validated id** (`canvasLayerRelPath`).
 *    No function here accepts a caller's path.
 *  - **No link anywhere on the way.** `.studio`, `.studio/canvas` and the file
 *    itself must be real directory entries, not symlinks or junctions, and the
 *    real path must spell exactly `.studio/canvas/<id>.tsx` under the real
 *    project root. A cloned repository can carry a symlink (git stores them),
 *    and a `.studio/canvas` linked into `pages/` would otherwise turn a scratch
 *    layer into a real page, or one linked into `.git/hooks` into a hook.
 *  - **Create is exclusive.** A create never overwrites: the name must be free
 *    (probed with `lstat`, which sees a dangling link that `existsSync` would
 *    miss), and the write itself is `wx`.
 *  - **Delete only removes a regular file.**
 *  - **A size cap.** The one content a client supplies verbatim is an undo's
 *    restore text; a layer module is a few lines, so 512 KB is generous.
 *
 * Nothing here parses or runs the module. Loading it is
 * `canvasLayerLoad.ts`'s job, and it only ever parses (Tier 0), never executes.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathEntryExists, realWorkspaceRel } from '@core/page-parser'
import {
  CANVAS_LAYER_DIR,
  canvasLayerRelPath,
  isCanvasLayerId,
  type CanvasLayerId,
} from '@core/studio-board'

/** The largest layer module Studio will write. */
export const CANVAS_LAYER_MAX_BYTES = 512 * 1024

const LAYER_FILE_NAME = /^(cl[a-z0-9]{10})\.tsx$/

/** Why a layer file operation did not happen, in words for the person who asked. */
export class CanvasLayerFileError extends Error {
  constructor(
    readonly reason: 'invalid-layer' | 'layer-exists' | 'layer-missing' | 'layer-unsafe-path' | 'layer-too-large',
    message: string,
  ) {
    super(message)
    this.name = 'CanvasLayerFileError'
  }
}

/** Whether `path` exists and is a symlink/junction. A missing entry is not a link. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The absolute path of layer `id`'s module under `dir`, or `null` when writing
 * or reading it would go anywhere other than exactly `<dir>/.studio/canvas/<id>.tsx`.
 */
export function canvasLayerFilePath(dir: string, id: string): string | null {
  if (!isCanvasLayerId(id)) return null
  const rel = canvasLayerRelPath(id)
  const studioDir = join(dir, '.studio')
  const canvasDir = join(dir, ...CANVAS_LAYER_DIR.split('/'))
  const file = join(dir, ...rel.split('/'))
  if (isLink(studioDir) || isLink(canvasDir) || isLink(file)) return null
  // The real path of the target (through its deepest existing ancestor) must
  // be the exact spelling: no link above the project root's own resolution,
  // no case variant, no escape.
  return realWorkspaceRel(dir, file) === rel ? file : null
}

function requirePath(dir: string, id: string): string {
  if (!isCanvasLayerId(id)) {
    throw new CanvasLayerFileError('invalid-layer', 'That is not a canvas layer Studio made, so nothing was written.')
  }
  const file = canvasLayerFilePath(dir, id)
  if (!file) {
    throw new CanvasLayerFileError(
      'layer-unsafe-path',
      "This project's .studio/canvas folder is a link to somewhere else, so Studio will not write canvas layers into it. Replace the link with an ordinary folder.",
    )
  }
  return file
}

/** Every layer id with a module on disk, in name order. A link, a directory or a stray file is skipped. */
export function listCanvasLayerIds(dir: string): CanvasLayerId[] {
  const canvasDir = join(dir, ...CANVAS_LAYER_DIR.split('/'))
  if (isLink(join(dir, '.studio')) || isLink(canvasDir)) return []
  let names: string[]
  try {
    names = readdirSync(canvasDir)
  } catch {
    return []
  }
  const ids: CanvasLayerId[] = []
  for (const name of names.sort()) {
    const match = LAYER_FILE_NAME.exec(name)
    if (!match) continue
    try {
      if (!lstatSync(join(canvasDir, name)).isFile()) continue
    } catch {
      continue
    }
    ids.push(match[1] as CanvasLayerId)
  }
  return ids
}

/** The module's text, or `null` when it does not exist (or is not a safe path). */
export function readCanvasLayerFile(dir: string, id: string): string | null {
  const file = canvasLayerFilePath(dir, id)
  if (!file) return null
  try {
    if (!lstatSync(file).isFile()) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Write a NEW layer module. Refuses when the name is taken — a create never overwrites. */
export function writeNewCanvasLayerFile(dir: string, id: string, text: string): string {
  const file = requirePath(dir, id)
  if (Buffer.byteLength(text, 'utf8') > CANVAS_LAYER_MAX_BYTES) {
    throw new CanvasLayerFileError('layer-too-large', 'That canvas layer is larger than Studio writes to the free canvas, so nothing was written.')
  }
  if (pathEntryExists(file)) {
    throw new CanvasLayerFileError('layer-exists', 'A canvas layer with that id already exists, so nothing was written.')
  }
  mkdirSync(join(dir, ...CANVAS_LAYER_DIR.split('/')), { recursive: true })
  // Re-checked after the mkdir: creating the folder cannot have produced a
  // link, but a racing writer could have, and this is the cheap moment to see it.
  if (!canvasLayerFilePath(dir, id)) {
    throw new CanvasLayerFileError('layer-unsafe-path', "This project's .studio/canvas folder is not an ordinary folder, so nothing was written.")
  }
  writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' })
  return file
}

/** Remove a layer module and return the text it held — an undo writes it back. */
export function removeCanvasLayerFile(dir: string, id: string): string {
  const file = requirePath(dir, id)
  let text: string
  try {
    if (!lstatSync(file).isFile()) throw new Error('not a file')
    text = readFileSync(file, 'utf8')
  } catch {
    throw new CanvasLayerFileError('layer-missing', 'That canvas layer is no longer on disk, so there was nothing to remove.')
  }
  unlinkSync(file)
  return text
}
