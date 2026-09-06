/**
 * StudioBoardLayers — the seven Studio board overlay layers, bundled behind
 * one lazy boundary.
 *
 * `BoardFramesLayer`, `BoardNotesLayer`, `BoardDocsLayer`, `BoardGuidesLayer`,
 * and `RulerGuidesLayer`, and `BoardCommentsLayer` all self-gate on `selectActiveBoard` (or, for the
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
 * five files (`rectResize.ts`, `frameVirtualization.ts`, `boardSnapping.ts`,
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
 * second-to-last so its interactive drag/delete affordances paint above the
 * board furniture.
 *
 * The two prototype layers mount next, derived under authored: `BoardFlowLayer`
 * draws the read-only flows Studio derived from the project's own navigation
 * code, `BoardPrototypeLayer` the links the user drew plus the `+` handle that
 * draws them — so the interactive one paints over the report, and a click near
 * both lands on the thing that can actually be changed. Both are inert even
 * INSIDE Studio unless `boardMode` is `prototype`, so their cost on a normal
 * editing session is one store read each.
 *
 * `BoardCommentsLayer` mounts LAST of all. A review pin has to stay clickable
 * over frames, notes, docs, snap guides, ruler guides and flow connectors
 * alike — it is the only thing on the board that is ABOUT the board rather
 * than part of it. It also self-gates on `selectActiveBoard`, so this is still
 * a stack of layers that all render `null` outside Studio.
 */
import { BoardFramesLayer } from './BoardFramesLayer/BoardFramesLayer'
import { BoardNotesLayer } from './BoardNotesLayer/BoardNotesLayer'
import { BoardDocsLayer } from './BoardDocsLayer/BoardDocsLayer'
import { BoardGuidesLayer } from './BoardGuidesLayer/BoardGuidesLayer'
import { RulerGuidesLayer } from './RulerGuidesLayer/RulerGuidesLayer'
import { BoardFlowLayer } from './BoardFlowLayer/BoardFlowLayer'
import { BoardPrototypeLayer } from './BoardPrototypeLayer/BoardPrototypeLayer'
import { BoardCommentsLayer } from './BoardCommentsLayer/BoardCommentsLayer'

export function StudioBoardLayers() {
  return (
    <>
      <BoardFramesLayer />
      <BoardNotesLayer />
      <BoardDocsLayer />
      <BoardGuidesLayer />
      <RulerGuidesLayer />
      <BoardFlowLayer />
      <BoardPrototypeLayer />
      <BoardCommentsLayer />
    </>
  )
}
