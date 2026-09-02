import { Type } from '@sinclair/typebox'
import { safeParseJson } from '@core/utils/jsonValidate'

export const MEDIA_ASSET_DRAG_TYPE = 'application/x-studio-media-assets'
const MEDIA_FOLDER_DRAG_TYPE = 'application/x-studio-media-folder'

const MediaAssetDragPayloadSchema = Type.Object({
  assetIds: Type.Array(Type.String()),
})

const MediaFolderDragPayloadSchema = Type.Object({
  folderId: Type.String(),
})

export type MediaDropPayload =
  | { kind: 'assets'; assetIds: string[] }
  | { kind: 'folder'; folderId: string }

function hasType(dataTransfer: DataTransfer, type: string): boolean {
  return Array.from(dataTransfer.types).includes(type)
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function hasMediaDropData(dataTransfer: DataTransfer): boolean {
  return hasType(dataTransfer, MEDIA_ASSET_DRAG_TYPE) || hasType(dataTransfer, MEDIA_FOLDER_DRAG_TYPE)
}

/**
 * A same-document mirror of the active media drag's payload, outside
 * `DataTransfer`.
 *
 * Per the HTML drag-and-drop spec, `DataTransfer` is in "protected mode"
 * during `dragover` — `dataTransfer.getData()` is REQUIRED to return `""`
 * there (readable only on `dragstart` and `drop`). `dataTransfer.types` IS
 * readable during `dragover` (`hasMediaDropData` relies on that), but it
 * carries no payload, only type names.
 *
 * Media drags never leave this single admin document (no iframe boundary),
 * so a module-scoped variable set on `dragstart` (by `writeMedia*DragData`,
 * called from every drag source's `onDragStart`) and cleared on `dragend` is
 * a safe substitute: it lets `useMediaDnd`'s `handleDragOver` judge legality
 * (self-drop, drop-onto-own-parent, descendant-cycle — `canAcceptDrop` in
 * `mediaDnd.ts`) BEFORE the drop, instead of treating an unreadable payload
 * as always legal. Before this existed, `canAcceptDrop(workspace, null, …)`
 * short-circuited to `true` for every `dragover`, so illegal folder drops
 * highlighted as valid drop targets and then silently no-opped on drop.
 */
let activeDragPayload: MediaDropPayload | null = null

/** The active drag's payload, or `null` when no media drag is in flight. */
export function readActiveMediaDragPayload(): MediaDropPayload | null {
  return activeDragPayload
}

/** Called on `dragend` (drop or cancel) — see `useMediaDnd`'s document listener. */
export function clearActiveMediaDragPayload(): void {
  activeDragPayload = null
}

export function writeMediaAssetDragData(dataTransfer: DataTransfer, assetIds: string[]) {
  const cleanIds = uniqueNonEmpty(assetIds)
  if (cleanIds.length === 0) return
  dataTransfer.setData(MEDIA_ASSET_DRAG_TYPE, JSON.stringify({ assetIds: cleanIds }))
  dataTransfer.effectAllowed = 'move'
  activeDragPayload = { kind: 'assets', assetIds: cleanIds }
}

export function writeMediaFolderDragData(dataTransfer: DataTransfer, folderId: string) {
  const cleanId = folderId.trim()
  if (!cleanId) return
  dataTransfer.setData(MEDIA_FOLDER_DRAG_TYPE, JSON.stringify({ folderId: cleanId }))
  dataTransfer.effectAllowed = 'move'
  activeDragPayload = { kind: 'folder', folderId: cleanId }
}

export function readMediaDropPayload(dataTransfer: DataTransfer): MediaDropPayload | null {
  const assetRaw = dataTransfer.getData(MEDIA_ASSET_DRAG_TYPE)
  if (assetRaw) {
    const parsed = safeParseJson(assetRaw, MediaAssetDragPayloadSchema)
    if (parsed.ok) {
      const assetIds = uniqueNonEmpty(parsed.value.assetIds)
      if (assetIds.length > 0) return { kind: 'assets', assetIds }
    }
  }

  const folderRaw = dataTransfer.getData(MEDIA_FOLDER_DRAG_TYPE)
  if (folderRaw) {
    const parsed = safeParseJson(folderRaw, MediaFolderDragPayloadSchema)
    if (parsed.ok) return { kind: 'folder', folderId: parsed.value.folderId }
  }

  return null
}
