/**
 * StudioCanvasChrome — the UNTRANSFORMED studio-only canvas chrome, bundled
 * behind one lazy boundary.
 *
 * Two pieces that must sit outside `CanvasTransformLayer` (so they never scale
 * with pan/zoom) and are meaningless outside a Studio board:
 *
 *   - `BoardNotesToolbar` — "+ Sticky note" / "+ Doc" / the comment tool.
 *   - `CommentPlacementLayer` — the armed comment tool's capture surface,
 *     which renders `null` unless the tool is on.
 *
 * Both self-gate on `selectActiveBoard`, so mounting this changes nothing
 * outside Studio — it changes only WHEN the chunk is fetched. That matters:
 * `BoardNotesToolbar` used to be imported eagerly by `CanvasRoot`, which put
 * it (and now the whole comments graph — `@core/studio-comments`, the store
 * slice, the composer) into the SitePage route chunk for every CMS editor
 * session that will never render a board. Same reasoning, and the same shape,
 * as `StudioBoardLayers` one tier down.
 *
 * `CommentPlacementLayer` needs the transform layer's ref, because that
 * element's own client rect is the board's screen origin — see its module doc.
 */
import type { RefObject } from 'react'
import { BoardNotesToolbar } from './BoardNotesLayer/BoardNotesToolbar'
import { CommentPlacementLayer } from './BoardCommentsLayer/CommentPlacementLayer'

interface StudioCanvasChromeProps {
  transformLayerRef: RefObject<HTMLDivElement | null>
}

export function StudioCanvasChrome({ transformLayerRef }: StudioCanvasChromeProps) {
  return (
    <>
      <BoardNotesToolbar />
      {/*
        Sits at z-index 52 — over the portaled selection/hover rings (51), so a
        click on a selected element places a comment instead of re-grabbing the
        selection chrome, and under the notes toolbar (53), so the button that
        armed the tool stays clickable to disarm it.
      */}
      <CommentPlacementLayer transformLayerRef={transformLayerRef} />
    </>
  )
}
