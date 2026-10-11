/**
 * SB-3 — a press on a frame that has NO live document (a poster) can resolve
 * its layer from the rect index alone. `resolveCanvasPressTarget` was already
 * pure over the page tree (a hit id in, a layer id out; it never reads the
 * DOM), so what makes poster-frame selection possible is only where the hit id
 * comes from: `FrameGeometryIndex.hitTest` instead of a DOM event target. This
 * test composes the two with no document at all and checks the result equals
 * what the same press means with the DOM's own answer.
 */
import { describe, expect, it } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import { resolveCanvasPressTarget, type CanvasPressContext } from '@site/canvas/canvasPressTarget'
import { FrameGeometryIndex } from '@site/canvas/frameGeometry/frameGeometryIndex'
import type { NodeGeometry } from '@site/canvas/frameGeometry/frameGeometryTypes'

const ROOT = 'p:body'
const node = (id: string, children: string[], parentId: string | null, moduleId = 'base.container'): PageNode =>
  ({ id, moduleId, props: {}, breakpointOverrides: {}, children, classIds: [], parentId }) as unknown as PageNode

/** body > screen > [card > [title, label], footer] */
const tree = {
  rootNodeId: ROOT,
  nodes: {
    [ROOT]: node(ROOT, ['screen'], null, 'base.body'),
    screen: node('screen', ['card', 'footer'], ROOT),
    card: node('card', ['title', 'label'], 'screen'),
    title: node('title', [], 'card', 'base.text'),
    label: node('label', [], 'card', 'base.text'),
    footer: node('footer', [], 'screen', 'base.text'),
  },
} as unknown as NodeTree<PageNode>

const geometry = (nodeId: string, x: number, y: number, width: number, height: number, parent: number): NodeGeometry => ({
  nodeId,
  rect: { x, y, width, height },
  parent,
  clips: false,
  inert: false,
  transformed: false,
  paint: 0,
})

const index = FrameGeometryIndex.fromSnapshot(
  {
    origin: { x: 0, y: 0 },
    truncated: false,
    nodes: [
      geometry(ROOT, 0, 0, 400, 700, -1),
      geometry('screen', 0, 0, 400, 600, 0),
      geometry('card', 20, 20, 360, 200, 1),
      geometry('title', 30, 30, 200, 30, 2),
      geometry('label', 30, 80, 200, 30, 2),
      geometry('footer', 20, 540, 360, 40, 1),
    ],
  },
  // The frame sits at board (5000, 3000): the press point is in board units, no iframe involved.
  { x: 5000, y: 3000 },
)

const context = (selectedIds: string[] = []): CanvasPressContext => ({ selectedIds, enteredInstanceIds: [], vcLockdown: true })

/** What the canvas would do for a press at a board point, from the index alone. */
function pressAt(x: number, y: number, selectedIds: string[] = [], deep = false): string | null {
  const hit = index.hitTest({ x, y })
  return hit === null ? null : resolveCanvasPressTarget(tree, hit.nodeId, context(selectedIds), { deep })
}

describe('a press resolved from the rect index', () => {
  it('selects the layer at the frame depth: the card for a press on its title, the footer for the footer', () => {
    expect(pressAt(5040, 3040)).toBe('card')
    expect(pressAt(5100, 3550)).toBe('footer')
  })

  it('goes to the innermost layer with the deep modifier', () => {
    expect(pressAt(5040, 3040, [], true)).toBe('title')
  })

  it('keeps the depth of the selection: inside the selected card it stays the card, and beside the selected title it is the sibling', () => {
    expect(pressAt(5040, 3090, ['card'])).toBe('card')
    expect(pressAt(5040, 3090, ['title'])).toBe('label')
  })

  it('a press on the screen own background selects the screen; below it, on the bare page body, no layer', () => {
    expect(pressAt(5000, 3595)).toBe('screen')
    expect(pressAt(5000, 3650)).toBeNull()
  })

  it('a press outside the frame resolves to nothing at all', () => {
    expect(pressAt(100, 100)).toBeNull()
  })
})
