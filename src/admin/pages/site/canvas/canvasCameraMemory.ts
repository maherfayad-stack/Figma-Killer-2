/**
 * canvasCameraMemory - where the user left the board's camera, per project and
 * board, so reopening the editor lands where they were instead of at a fixed
 * default with the frames partly off screen.
 *
 * The camera is a preference of the person's view, not part of the project, so
 * it lives in `localStorage` (TypeBox-validated on read like every persisted
 * value). A missing, malformed or absurd entry is "no memory": the caller fits
 * the board instead.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'

const CameraSchema = Type.Object({ zoom: Type.Number(), panX: Type.Number(), panY: Type.Number() })
const CameraBookSchema = Type.Record(Type.String(), CameraSchema)

export type RememberedCamera = Static<typeof CameraSchema>

export const CANVAS_CAMERA_STORAGE_KEY = 'studio-canvas-camera-v1'

/** Most boards remembered; the oldest entry is dropped past this. */
const MAX_REMEMBERED_BOARDS = 50

const bookKey = (boardId: string): string => `${getStudioWorkspaceDir() ?? ''}|${boardId}`

function readBook(): Record<string, RememberedCamera> {
  if (typeof localStorage === 'undefined') return {}
  try {
    return parseJsonWithFallback(localStorage.getItem(CANVAS_CAMERA_STORAGE_KEY), CameraBookSchema, {})
  } catch (_err) {
    // A storage that throws on read (a locked-down profile) is "no memory".
    return {}
  }
}

/** The camera last left on `boardId`, or `null` when there is none worth restoring. */
export function recallCamera(boardId: string): RememberedCamera | null {
  const camera = readBook()[bookKey(boardId)]
  if (!camera) return null
  const finite = Number.isFinite(camera.zoom) && Number.isFinite(camera.panX) && Number.isFinite(camera.panY)
  return finite && camera.zoom > 0 ? camera : null
}

/** Best-effort write - a full or disabled storage just means the next open fits the board. */
export function rememberCamera(boardId: string, camera: RememberedCamera): void {
  if (typeof localStorage === 'undefined') return
  try {
    const book = readBook()
    const key = bookKey(boardId)
    delete book[key]
    book[key] = camera
    const keys = Object.keys(book)
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_BOARDS))) delete book[stale]
    localStorage.setItem(CANVAS_CAMERA_STORAGE_KEY, JSON.stringify(book))
  } catch (err) {
    console.warn('[canvasCameraMemory] could not remember the camera:', err)
  }
}
