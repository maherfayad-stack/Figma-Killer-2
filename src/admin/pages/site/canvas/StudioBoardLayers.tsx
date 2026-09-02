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
 * `BoardPrototypeLayer` mounts second-to-last: connectors have to draw over
 * frames and furniture alike (a link crosses the board), but UNDER a review
 * pin, which is about the board rather than part of it. It self-gates on
 * prototype mode, so in the overwhelmingly common case it renders `null` and
 * measures nothing.
 *
 * `BoardCommentsLayer` mounts LAST of all. A review pin has to stay clickable
 * over frames, notes, docs, snap guides and ruler guides alike — it is the
 * only thing on the board that is ABOUT the board rather than part of it.
 * It also self-gates on `selectActiveBoard`, so this is still seven layers
 * that all render `null` outside Studio.
 */
import { BoardFramesLayer } from './BoardFramesLayer/BoardFramesLayer'
import { BoardNotesLayer } from './BoardNotesLayer/BoardNotesLayer'
import { BoardDocsLayer } from './BoardDocsLayer/BoardDocsLayer'
import { BoardGuidesLayer } from './BoardGuidesLayer/BoardGuidesLayer'
import { RulerGuidesLayer } from './RulerGuidesLayer/RulerGuidesLayer'
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
      <BoardPrototypeLayer />
      <BoardCommentsLayer />
    </>
  )
}
