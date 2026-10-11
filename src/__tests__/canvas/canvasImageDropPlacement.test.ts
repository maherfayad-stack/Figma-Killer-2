/**
 * P5-B (IMG-9) — a dropped image's written size and ⌘-drop position.
 *
 * The size is the file's own, never wider than the container's content box,
 * aspect kept; unknown means no attributes at all. The position is K6's rule:
 * the pointer's offset from the padding box (now `canvasNewLayerPlacement.test.ts`).
 */
import { describe, expect, it } from 'bun:test'
import {
  IMAGE_CASCADE_STEP_PX,
  absolutePlacementStyle,
  clampImageSize,
} from '@site/store/slices/site/imageDropShapes'
import { resolveSelectionInsertTarget } from '@site/canvas/canvasSelectionInsert'
import { makeNode, makePage } from '../fixtures'

describe('clampImageSize', () => {
  it('keeps an image that already fits at its own size', () => {
    expect(clampImageSize({ width: 320, height: 200 }, 390)).toEqual({ width: 320, height: 200 })
  })

  it('scales a 4000 px photo down to a 390 px container, keeping the aspect', () => {
    expect(clampImageSize({ width: 4000, height: 3000 }, 390)).toEqual({ width: 390, height: 293 })
  })

  it('never scales UP', () => {
    expect(clampImageSize({ width: 40, height: 40 }, 1200)).toEqual({ width: 40, height: 40 })
  })

  it('writes nothing when the file does not say its size', () => {
    expect(clampImageSize({ width: null, height: 300 }, 390)).toBeNull()
    expect(clampImageSize({ width: 300, height: null }, 390)).toBeNull()
  })

  it('does not clamp against an unmeasured container', () => {
    expect(clampImageSize({ width: 4000, height: 3000 }, null)).toEqual({ width: 4000, height: 3000 })
  })
})

describe('absolutePlacementStyle', () => {
  it('cascades each further image by one step', () => {
    const placement = { property: 'left' as const, inline: 10, top: 20 }
    expect(absolutePlacementStyle(placement, 2)).toEqual({
      position: 'absolute',
      left: `${10 + 2 * IMAGE_CASCADE_STEP_PX}px`,
      top: `${20 + 2 * IMAGE_CASCADE_STEP_PX}px`,
    })
  })
})

describe('resolveSelectionInsertTarget — IX-img and P5-A paste, beside the selection', () => {
  const ROOT = 'home:body'
  const MAIN = 'pages/Home.tsx:4:5'
  const A = 'pages/Home.tsx:5:7'
  const B = 'pages/Home.tsx:6:7'
  const tree = makePage({
    id: 'home',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', children: [MAIN] }),
      [MAIN]: makeNode({ id: MAIN, moduleId: 'base.container', children: [A, B], parentId: ROOT }),
      [A]: makeNode({ id: A, moduleId: 'base.text', parentId: MAIN }),
      [B]: makeNode({ id: B, moduleId: 'base.text', parentId: MAIN }),
    },
  })

  it('lands right after the selected layer, in its parent', () => {
    expect(resolveSelectionInsertTarget('home', tree, A)).toEqual({ ok: true, pageId: 'home', parentId: MAIN, index: 1 })
  })

  it('appends to the page root when nothing in this frame is selected', () => {
    expect(resolveSelectionInsertTarget('home', tree, null)).toEqual({ ok: true, pageId: 'home', parentId: ROOT, index: 1 })
    expect(resolveSelectionInsertTarget('home', tree, 'other.tsx:1:1')).toEqual({ ok: true, pageId: 'home', parentId: ROOT, index: 1 })
  })

  it('refuses with no active frame, before any dialog opens', () => {
    expect(resolveSelectionInsertTarget(null, null, null).ok).toBe(false)
  })
})
