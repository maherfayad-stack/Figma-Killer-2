/**
 * frameAlign — pure board-space geometry for bulk frame align/distribute
 * (WS-7.2). Sibling of `frameGrid.ts`/`frameResize.ts`/`frameVirtualization.ts`
 * — same "pure, no React, no store" shape, consumed by `boardSlice`'s
 * `alignSelectedFrames`/`distributeSelectedFrames` actions.
 */

/** Edge (or center line) every selected frame's box aligns to. */
export type FrameAlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

export interface AlignableFrame {
  pageId: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * New x/y per pageId so every frame's chosen edge (or center line) lines up
 * with the group's shared extreme.
 */
export function alignFrames(frames: AlignableFrame[], edge: FrameAlignEdge): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>()
  if (frames.length === 0) return result
  switch (edge) {
    case 'left': {
      const target = Math.min(...frames.map((f) => f.x))
      for (const f of frames) result.set(f.pageId, { x: target, y: f.y })
      break
    }
    case 'right': {
      const target = Math.max(...frames.map((f) => f.x + f.width))
      for (const f of frames) result.set(f.pageId, { x: target - f.width, y: f.y })
      break
    }
    case 'center': {
      const min = Math.min(...frames.map((f) => f.x))
      const max = Math.max(...frames.map((f) => f.x + f.width))
      const mid = (min + max) / 2
      for (const f of frames) result.set(f.pageId, { x: mid - f.width / 2, y: f.y })
      break
    }
    case 'top': {
      const target = Math.min(...frames.map((f) => f.y))
      for (const f of frames) result.set(f.pageId, { x: f.x, y: target })
      break
    }
    case 'bottom': {
      const target = Math.max(...frames.map((f) => f.y + f.height))
      for (const f of frames) result.set(f.pageId, { x: f.x, y: target - f.height })
      break
    }
    case 'middle': {
      const min = Math.min(...frames.map((f) => f.y))
      const max = Math.max(...frames.map((f) => f.y + f.height))
      const mid = (min + max) / 2
      for (const f of frames) result.set(f.pageId, { x: f.x, y: mid - f.height / 2 })
      break
    }
  }
  return result
}

/**
 * Even gaps between frames along `axis`, ordered by their current position —
 * the two extreme (first/last) frames stay in place, the rest space out
 * evenly between them. A no-op (empty result) below 3 frames — with fewer
 * than that there's nothing to redistribute.
 */
export function distributeFrames(
  frames: AlignableFrame[],
  axis: 'horizontal' | 'vertical',
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>()
  if (frames.length < 3) return result

  const sorted = [...frames].sort((a, b) => (axis === 'horizontal' ? a.x - b.x : a.y - b.y))
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!

  if (axis === 'horizontal') {
    const totalSpan = last.x + last.width - first.x
    const totalWidth = sorted.reduce((sum, f) => sum + f.width, 0)
    const gap = (totalSpan - totalWidth) / (sorted.length - 1)
    let cursor = first.x
    for (const f of sorted) {
      result.set(f.pageId, { x: cursor, y: f.y })
      cursor += f.width + gap
    }
  } else {
    const totalSpan = last.y + last.height - first.y
    const totalHeight = sorted.reduce((sum, f) => sum + f.height, 0)
    const gap = (totalSpan - totalHeight) / (sorted.length - 1)
    let cursor = first.y
    for (const f of sorted) {
      result.set(f.pageId, { x: f.x, y: cursor })
      cursor += f.height + gap
    }
  }
  return result
}
