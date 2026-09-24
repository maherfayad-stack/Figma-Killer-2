/**
 * P5-B (IMG-9) — a dropped image's written size and ⌘-drop position.
 *
 * The size is the file's own, never wider than the container's content box,
 * aspect kept; unknown means no attributes at all. The position is K6's rule:
 * the pointer's offset from the padding box, only inside a positioned
 * container, written as the logical inline start under RTL.
 */
import { describe, expect, it } from 'bun:test'
import {
  IMAGE_CASCADE_STEP_PX,
  absolutePlacementStyle,
  clampImageSize,
  resolveAbsolutePlacement,
  type DropContainerBox,
} from '@site/canvas/canvasImageDropPlacement'
import { resolvePickedImageTarget } from '@site/canvas/canvasImagePicker'
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

describe('resolveAbsolutePlacement — K6', () => {
  const box = (overrides: Partial<DropContainerBox> = {}): DropContainerBox => ({
    contentWidth: 360,
    paddingOrigin: { x: 20, y: 30 },
    paddingWidth: 400,
    position: 'relative',
    direction: 'ltr',
    ...overrides,
  })

  it('measures from the padding box', () => {
    expect(resolveAbsolutePlacement(box(), { x: 120, y: 80 })).toEqual({
      ok: true,
      placement: { property: 'left', inline: 100, top: 50 },
    })
  })

  it('writes inset-inline-start, measured from the right edge, under RTL', () => {
    expect(resolveAbsolutePlacement(box({ direction: 'rtl' }), { x: 120, y: 80 })).toEqual({
      ok: true,
      placement: { property: 'insetInlineStart', inline: 300, top: 50 },
    })
  })

  it('refuses a static container — the image would escape it', () => {
    expect(resolveAbsolutePlacement(box({ position: 'static' }), { x: 120, y: 80 })).toEqual({
      ok: false,
      reason: 'static-parent',
    })
  })

  it('cascades each further image by one step', () => {
    const placement = { property: 'left' as const, inline: 10, top: 20 }
    expect(absolutePlacementStyle(placement, 2)).toEqual({
      position: 'absolute',
      left: `${10 + 2 * IMAGE_CASCADE_STEP_PX}px`,
      top: `${20 + 2 * IMAGE_CASCADE_STEP_PX}px`,
    })
  })
})

describe('resolvePickedImageTarget — IX-img, beside the selection', () => {
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
    expect(resolvePickedImageTarget('home', tree, A)).toEqual({ ok: true, pageId: 'home', parentId: MAIN, index: 1 })
  })

  it('appends to the page root when nothing in this frame is selected', () => {
    expect(resolvePickedImageTarget('home', tree, null)).toEqual({ ok: true, pageId: 'home', parentId: ROOT, index: 1 })
    expect(resolvePickedImageTarget('home', tree, 'other.tsx:1:1')).toEqual({ ok: true, pageId: 'home', parentId: ROOT, index: 1 })
  })

  it('refuses with no active frame, before any dialog opens', () => {
    expect(resolvePickedImageTarget(null, null, null).ok).toBe(false)
  })
})
