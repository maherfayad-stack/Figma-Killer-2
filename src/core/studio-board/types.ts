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

// a page rendered as a frame at (x,y)
export interface BoardFrame {
  pageId: string
  x: number
  y: number
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
