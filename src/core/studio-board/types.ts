import { Type, type Static } from '@sinclair/typebox'
import type { PreviewAxes } from './previewAxes'

export type NoteColor = 'yellow' | 'green' | 'blue' | 'pink' | 'gray'

export interface StickyNote {
  id: string
  x: number
  y: number
  w: number
  h: number
  text: string
  color: NoteColor
}

// a page rendered as a frame at (x,y). `width`/`height` are optional — a
// frame without them falls back to the shared `FRAME_WIDTH`/`FRAME_HEIGHT`
// defaults (`./frameGrid`) at render time, so
// pre-6E `boards.json` files keep opening at their original 1024×800 size
// with no migration needed.
//
// `id` (WS-10 Phase 2) is the frame's OWN identity — separate from `pageId`.
// Before "duplicate as variant" a board never had two frames of the same
// page, so `pageId` alone was an unambiguous frame key; a duplicated variant
// breaks that (two `BoardFrame`s, same `pageId`, different `axes`), so every
// per-frame operation (position, size, axes, removal) now addresses a frame
// by `id`. `pageId` keeps meaning exactly what it always did — which page's
// node tree this frame renders — and a NODE's id is UNCHANGED (trap #2): two
// variant frames of one page legitimately share every node id, because
// editing either one has to hit the same JSX. `id` is required on every
// frame this codebase WRITES; `serialize.ts`'s `coerceFrame` synthesizes it
// from `pageId` for a pre-Phase-2 `boards.json` (which never had more than
// one frame per page, so `pageId` is a perfectly stable, deterministic,
// already-unique substitute — no migration needed, no id churn on re-save).
//
// `axes` (WS-10 Phase 2, §4.4) overrides the board-global `PreviewAxes`
// PER AXIS, not wholesale — a frame overriding only `direction` still
// inherits the board's current `colorScheme`. `undefined`/absent means
// "inherit the board default", matching the same optional-field precedent
// `width`/`height` already established for this interface.
export interface BoardFrame {
  id: string
  pageId: string
  x: number
  y: number
  width?: number
  height?: number
  axes?: Partial<PreviewAxes>
}

// a markdown-authored documentation card, rendered as canvas furniture
export interface DocBlock {
  id: string
  x: number
  y: number
  w: number
  h: number
  markdown: string
}

/**
 * D1 — a PERSISTED ruler guide (dragged out from `CanvasRulers`, saved to
 * `boards.json`). NOT the same thing as `SnapGuide` (`canvas/boardSnapping.ts`)
 * / `boardSnapGuides` (`boardSlice.ts`) — those are transient, computed-on-
 * every-drag alignment lines that never persist. Schema-first (TypeBox) per
 * this field's own contract, unlike its `BoardFrame`/`StickyNote`/`DocBlock`
 * siblings above, which predate that convention in this module and stay
 * plain interfaces — `axis`/`position` is intentionally the ONLY shape here,
 * so a schema costs nothing and buys a real `Static<>`-derived type.
 */
export const BoardGuideSchema = Type.Object({
  id: Type.String(),
  axis: Type.Union([Type.Literal('x'), Type.Literal('y')]),
  /** Board-space coordinate the guide sits at (board x for a vertical/`'x'` guide, board y for a horizontal/`'y'` guide). */
  position: Type.Number(),
})

export type BoardGuide = Static<typeof BoardGuideSchema>

export interface Board {
  id: string
  name: string
  frames: BoardFrame[]
  notes: StickyNote[]
  docs: DocBlock[]
  /**
   * Persisted ruler guides (D1). OPTIONAL, unlike `notes`/`docs` — every
   * OTHER place in the codebase that constructs a `Board` object literal
   * (test fixtures across `server/ai/**`, `server/handlers/**`, this
   * module's own tests) predates this field, so requiring it would silently
   * become a breaking type change for files this change has no business
   * touching. Read via `board.guides ?? []`, same as any other optional
   * array field. `serialize.ts`'s `coerceGuide` always produces `[]` (never
   * omits the key) for anything this codebase itself reads back from disk.
   */
  guides?: BoardGuide[]
}

export interface BoardsFile {
  version: 1
  boards: Board[]
}
