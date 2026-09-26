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
 *  - **No link anywhere on the way** — the `.studio` store rule, applied by
 *    the one store door (`studioStore.ts`): `.studio`, `.studio/canvas` and the file
 *    itself must be real directory entries, not symlinks or junctions, and the
 *    path must be exactly `.studio/canvas/<id>.tsx` under the project root. A cloned repository can carry a symlink (git stores them),
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
import { CANVAS_LAYER_DIR, canvasLayerRelPath, isCanvasLayerId, type CanvasLayerId } from '@core/studio-board'
import {
  StudioStoreEntryExistsError,
  StudioStoreLinkError,
  createStudioStoreFileExclusive,
  isStudioStorePathUnlinked,
  listStudioStoreDir,
  readStudioStoreText,
  removeStudioStoreEntry,
  studioStorePath,
  studioStoreProjectRel,
} from './studioStore'

/** The largest layer module Studio will write. */
export const CANVAS_LAYER_MAX_BYTES = 512 * 1024

/** `canvas` — the layer folder as a `.studio` store path. `CANVAS_LAYER_DIR` (`@core`) must name the same folder. */
const LAYER_STORE_DIR = 'canvas'
if (studioStoreProjectRel(LAYER_STORE_DIR) !== CANVAS_LAYER_DIR) {
  throw new Error(`canvasLayerFiles: CANVAS_LAYER_DIR (${CANVAS_LAYER_DIR}) is not .studio/${LAYER_STORE_DIR}`)
}

const LAYER_FILE_NAME = /^(cl[a-z0-9]{10})\.tsx$/

/** Why a layer file operation did not happen, in words for the person who asked. */
export type CanvasLayerFileErrorReason = 'invalid-layer' | 'layer-exists' | 'layer-missing' | 'layer-unsafe-path' | 'layer-too-large'

export class CanvasLayerFileError extends Error {
  readonly reason: CanvasLayerFileErrorReason

  constructor(reason: CanvasLayerFileErrorReason, message: string) {
    super(message)
    this.name = 'CanvasLayerFileError'
    this.reason = reason
  }
}

/** Layer `id`'s module as a `.studio` store path — built from the validated id, never from a caller's path. */
function layerStoreRel(id: CanvasLayerId): string {
  return `${LAYER_STORE_DIR}/${canvasLayerRelPath(id).slice(CANVAS_LAYER_DIR.length + 1)}`
}

/**
 * The absolute path of layer `id`'s module under `dir`, or `null` when writing
 * or reading it would go anywhere other than exactly `<dir>/.studio/canvas/<id>.tsx`:
 * any link on the way, dangling or not, in or out of the project (`studioStore.ts`).
 */
export function canvasLayerFilePath(dir: string, id: string): string | null {
  if (!isCanvasLayerId(id)) return null
  const rel = layerStoreRel(id)
  return isStudioStorePathUnlinked(dir, rel) ? studioStorePath(dir, rel) : null
}

function requireLayerRel(dir: string, id: string): string {
  if (!isCanvasLayerId(id)) {
    throw new CanvasLayerFileError('invalid-layer', 'That is not a canvas layer Studio made, so nothing was written.')
  }
  if (!canvasLayerFilePath(dir, id)) {
    throw new CanvasLayerFileError(
      'layer-unsafe-path',
      "This project's canvas-layer folder is a link to somewhere else, so Studio will not write canvas layers into it. Replace the link with an ordinary folder.",
    )
  }
  return layerStoreRel(id)
}

/** Every layer id with a module on disk, in name order. A link, a directory or a stray file is skipped. */
export function listCanvasLayerIds(dir: string): CanvasLayerId[] {
  const ids: CanvasLayerId[] = []
  for (const name of listStudioStoreDir(dir, LAYER_STORE_DIR).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()) {
    const match = LAYER_FILE_NAME.exec(name)
    if (match) ids.push(match[1] as CanvasLayerId)
  }
  return ids
}

/** Write a NEW layer module. Refuses when the name is taken — a create never overwrites. */
export function writeNewCanvasLayerFile(dir: string, id: string, text: string): string {
  const rel = requireLayerRel(dir, id)
  if (Buffer.byteLength(text, 'utf8') > CANVAS_LAYER_MAX_BYTES) {
    throw new CanvasLayerFileError('layer-too-large', 'That canvas layer is larger than Studio writes to the free canvas, so nothing was written.')
  }
  try {
    return createStudioStoreFileExclusive(dir, rel, text)
  } catch (err) {
    if (err instanceof StudioStoreEntryExistsError) {
      throw new CanvasLayerFileError('layer-exists', 'A canvas layer with that id already exists, so nothing was written.')
    }
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CanvasLayerFileError('layer-exists', 'A canvas layer with that id already exists, so nothing was written.')
    }
    if (err instanceof StudioStoreLinkError) {
      throw new CanvasLayerFileError('layer-unsafe-path', "This project's canvas-layer folder is not an ordinary folder, so nothing was written.")
    }
    throw err
  }
}

/** Remove a layer module and return the text it held — an undo writes it back. */
export function removeCanvasLayerFile(dir: string, id: string): string {
  const rel = requireLayerRel(dir, id)
  const text = readStudioStoreText(dir, rel)
  if (text === null) {
    throw new CanvasLayerFileError('layer-missing', 'That canvas layer is no longer on disk, so there was nothing to remove.')
  }
  removeStudioStoreEntry(dir, rel)
  return text
}
