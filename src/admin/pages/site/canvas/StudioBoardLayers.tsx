/**
 * StudioBoardLayers — the five Studio board overlay layers, bundled behind
 * one lazy boundary.
 *
 * `BoardFramesLayer`, `BoardNotesLayer`, `BoardDocsLayer`, `BoardGuidesLayer`,
 * and `RulerGuidesLayer` all self-gate on `selectActiveBoard` (or, for the
 * transient snap guides, on there being an active drag) — every one of them
 * renders `null` outside Studio's multi-frame board mode. `CanvasTransformLayer`
 * used to mount all four unconditionally (relying on that internal
 * null-return), which meant every CMS page/post editor session downloaded
 * the entire board-furniture graph (frame resize/virtualization, sticky
 * notes, doc blocks, snap guides) even though `activeBoard` is always `null`
 * outside Studio.
 *
 * `CanvasTransformLayer` now only mounts this component when `activeBoard`
 * is truthy, so the dynamic `import()` — and everything reachable from these
 * five files (`frameResize.ts`, `frameVirtualization.ts`, `boardSnapping.ts`,
 * `StickyNoteView`, `DocBlockView`, their CSS) — is never even requested for
 * the default (non-Studio) editor.
 *
 * Imports the layers by their concrete file paths rather than through each
 * folder's barrel, so this lazy boundary doesn't accidentally pull in
 * sibling barrel exports (`BoardNotesToolbar`, `AddFramePicker`,
 * `NewPageButton`) that have their own, separate eager/lazy story.
 *
 * `RulerGuidesLayer` (D1 — PERSISTED ruler guides, not to be confused with
 * `BoardGuidesLayer`'s transient snap guides, see that file's doc) mounts
 * LAST so its interactive drag/delete affordances paint above every other
 * board layer.
 */
import { BoardFramesLayer } from './BoardFramesLayer/BoardFramesLayer'
import { BoardNotesLayer } from './BoardNotesLayer/BoardNotesLayer'
import { BoardDocsLayer } from './BoardDocsLayer/BoardDocsLayer'
import { BoardGuidesLayer } from './BoardGuidesLayer/BoardGuidesLayer'
import { RulerGuidesLayer } from './RulerGuidesLayer/RulerGuidesLayer'

export function StudioBoardLayers() {
  return (
    <>
      <BoardFramesLayer />
      <BoardNotesLayer />
      <BoardDocsLayer />
      <BoardGuidesLayer />
      <RulerGuidesLayer />
    </>
  )
}
