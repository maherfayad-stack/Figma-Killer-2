/**
 * prototypeSlice — the editor's view of a project's flows.
 *
 * Two collections, and the difference between them is the whole feature:
 *
 *   - `prototype` — the links the USER drew, read from and written back to
 *     `<workspace>/.studio/prototype.json`. A design layer.
 *   - `codeFlow` — the navigation Studio DERIVED from the project's own source
 *     (`prototypeCodeFlow.ts` on the server). Read-only, never persisted,
 *     recomputed on every load. It is the part of the board that is true before
 *     anybody has drawn anything.
 *
 * NO HTTP HAPPENS HERE. The slice is a pure state container; the round trips
 * live in `@site/studio/prototypeActions.ts`, exactly the split `commentsSlice`
 * documents for itself and `boardSlice` prescribes generally.
 *
 * WHY `boardMode` LIVES HERE AND NOT IN `uiSlice`
 * ───────────────────────────────────────────────
 * `STUDIO-PROTOTYPE-PLAN.md` §6 put it in `uiSlice` alongside `canvasView`. It
 * is one flag either way, but it belongs with the state it gates: every reader
 * of `boardMode` is already reading `codeFlow` or `prototype`, and a component
 * that shows connectors would otherwise subscribe to two slices to answer one
 * question. `canvasView` (design/live) stays in `uiSlice` because it is about
 * the canvas SURFACE and means something on every CMS route too; `boardMode` is
 * meaningless without a Studio board.
 *
 * WHY THE MODE IS NOT PERSISTED
 * ─────────────────────────────
 * Prototype mode suppresses design chrome. Restoring it on load would open the
 * editor in a state where the user's first click does not select anything, with
 * no memory of having asked for that. Figma reopens on the Design tab too.
 */
import type { EditorStoreSliceCreator } from '@site/store/types'
import { createCodeFlow, createPrototypeFile, type CodeFlow, type PrototypeFile } from '@core/studio-prototype'

/**
 * Which layer of the board is being worked on.
 *
 *   - `design`    — the normal editing board. No connectors are drawn.
 *   - `prototype` — flows are drawn over the frames.
 *
 * This is NOT `canvasView`'s design/live axis. A board is in one of these two
 * modes while `canvasView` is `design`; `live` is the player, and has no
 * connectors of its own to show.
 */
export type BoardMode = 'design' | 'prototype'

export interface PrototypeSlice {
  /** Authored links (`.studio/prototype.json`). */
  prototype: PrototypeFile
  /** Navigation derived from the project's own source. Read-only. */
  codeFlow: CodeFlow
  prototypeLoaded: boolean
  /** The fetch failed — draw no connectors rather than claiming the project has no flows. */
  prototypeLoadFailed: boolean
  boardMode: BoardMode

  /** Adopt a freshly-read authored link file (from a load or an op's merged response). */
  adoptPrototype: (file: PrototypeFile) => void
  /** Adopt a freshly-derived code flow map. */
  adoptCodeFlow: (flow: CodeFlow) => void
  setPrototypeLoadFailed: (failed: boolean) => void
  setBoardMode: (mode: BoardMode) => void
}

export const createPrototypeSlice: EditorStoreSliceCreator<PrototypeSlice> = (set) => ({
  prototype: createPrototypeFile(),
  codeFlow: createCodeFlow(),
  prototypeLoaded: false,
  prototypeLoadFailed: false,
  boardMode: 'design',

  adoptPrototype: (file) =>
    set((s) => {
      s.prototype = file
      s.prototypeLoaded = true
      s.prototypeLoadFailed = false
    }),

  adoptCodeFlow: (flow) =>
    set((s) => {
      s.codeFlow = flow
    }),

  setPrototypeLoadFailed: (failed) =>
    set((s) => {
      s.prototypeLoadFailed = failed
    }),

  setBoardMode: (mode) =>
    set((s) => {
      s.boardMode = mode
    }),
})

declare module '@site/store/types' {
  interface EditorStore extends PrototypeSlice {}
}
