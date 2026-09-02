/**
 * useMediaCanvasInsertionDrag — drag a media asset from the explorer onto the
 * canvas.
 *
 * The gesture, the drop resolution and the click suppression are all
 * `useCanvasInsertionDrag`, shared with the canvas notch's element primitives
 * and the module inserter. This file owns only what is media-specific: which
 * module an asset becomes (`mediaCanvasInsertionForAsset` — an image, a video)
 * and the props it is inserted with.
 */
import { type PointerEvent as ReactPointerEvent } from 'react'
import { registry } from '@core/module-engine'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import type { CanvasDropPreview } from '@site/canvas/canvasInsertionDrop'
import { useCanvasInsertionDrag } from '@site/canvas/useCanvasInsertionDrag'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { mediaCanvasInsertionForAsset, type MediaCanvasInsertion } from './mediaCanvasInsertion'

interface MediaGhost {
  asset: CmsMediaAsset
  insertion: MediaCanvasInsertion
}

export interface MediaCanvasDragState extends MediaGhost {
  x: number
  y: number
  preview: CanvasDropPreview | null
}

export function useMediaCanvasInsertionDrag() {
  const insertModule = useInsertModule()

  const canvasDrag = useCanvasInsertionDrag<MediaGhost>({
    onDrop: ({ insertion }, location) => {
      const mod = registry.get(insertion.moduleId)
      if (!mod) return false
      return insertModule(mod, location, { defaults: insertion.defaults }) !== null
    },
  })

  const handlePointerDown = (asset: CmsMediaAsset, event: ReactPointerEvent<HTMLButtonElement>) => {
    const insertion = mediaCanvasInsertionForAsset(asset)
    if (!insertion) return
    canvasDrag.startDrag(event, { asset, insertion }, `Drop ${insertion.name.toLowerCase()}`)
  }

  // Flattened back into the shape the panel renders from — the ghost payload
  // and the pointer position are one object at the call site.
  const drag: MediaCanvasDragState | null = canvasDrag.drag
    ? { ...canvasDrag.drag.ghost, x: canvasDrag.drag.x, y: canvasDrag.drag.y, preview: canvasDrag.drag.preview }
    : null

  return { drag, handlePointerDown, shouldSuppressClick: canvasDrag.shouldSuppressClick }
}
