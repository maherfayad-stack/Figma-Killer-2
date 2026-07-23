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
// defaults (`@site/canvas/BoardFramesLayer/frameGrid`) at render time, so
// pre-6E `boards.json` files keep opening at their original 1024×800 size
// with no migration needed.
export interface BoardFrame {
  pageId: string
  x: number
  y: number
  width?: number
  height?: number
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

export interface Board {
  id: string
  name: string
  frames: BoardFrame[]
  notes: StickyNote[]
  docs: DocBlock[]
}

export interface BoardsFile {
  version: 1
  boards: Board[]
}
