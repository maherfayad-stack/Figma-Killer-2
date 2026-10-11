/**
 * pressSelectionTarget — a press selects the layer its click would, on the
 * way down.
 *
 * The reported two-phase selection: the press cleared the old selection (it
 * crossed into another frame's page), then a whole release later the real
 * layer was selected, behind a long task that only began at release. Selecting
 * on the press puts the ring on the layer with the finger, once. What it
 * selects is exactly what the click would (`resolveCanvasPressTarget`), so the
 * click that follows re-selects the same layer: a no-op, not a second one.
 */
import { describe, expect, it } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import type { EditorStore } from '@site/store/types'
import { pressSelectionTarget } from '@site/canvas/canvasPressSelect'
import { makePage, makeSite } from '../fixtures'

const ROOT = 'p:body'
const node = (id: string, children: string[], parentId: string | null, moduleId = 'base.container'): PageNode =>
  ({ id, moduleId, props: {}, breakpointOverrides: {}, children, classIds: [], parentId }) as unknown as PageNode

/** body > screen > card > [title, label] > …: the screen is the frame, the card its first layer. */
function state(selected: string[] = [], selectedNodeFrameId: string | null = null): EditorStore {
  const nodes: Record<string, PageNode> = {
    [ROOT]: node(ROOT, ['screen'], null, 'base.body'),
    screen: node('screen', ['card', 'footer'], ROOT),
    card: node('card', ['title', 'label'], 'screen'),
    title: node('title', [], 'card', 'base.text'),
    label: node('label', [], 'card', 'base.text'),
    footer: node('footer', [], 'screen', 'base.text'),
  }
  const site = makeSite({ pages: [makePage({ id: 'p', rootNodeId: ROOT, nodes })] })
  return {
    site,
    activePageId: 'p',
    activeDocument: null,
    selectedNodeIds: selected,
    selectedNodeFrameId,
    enteredInstanceIds: [],
    canvasLayerPages: {},
    localizedPages: {},
  } as unknown as EditorStore
}

const left = { button: 0, shiftKey: false, metaKey: false, ctrlKey: false }
const press = (hitId: string, selected: string[] = [], over: Partial<typeof left> = {}, frameId: string | null = null) =>
  pressSelectionTarget(state(selected), 'p', frameId, hitId, { ...left, ...over })

describe('pressSelectionTarget', () => {
  it('selects the layer at the current depth — the card, not the title it was pressed on — and does it ONCE', () => {
    expect(press('title')).toBe('card')
    // The click that follows resolves against the selection the press made and
    // finds the card already selected: nothing left for it to do.
    expect(press('title', ['card'])).toBeNull()
  })

  it('⌘/Ctrl goes straight to the innermost layer', () => {
    expect(press('title', [], { metaKey: true })).toBe('title')
    expect(press('title', ['card'], { ctrlKey: true })).toBe('title')
  })

  it('a sibling of the selected layer is selected on the press, not left for the click', () => {
    expect(press('footer', ['card'])).toBe('footer')
  })

  it('leaves a press inside the selection to the click — a multi-selection survives being grabbed', () => {
    expect(press('label', ['card', 'footer'])).toBeNull()
  })

  it('leaves ⇧ (a toggle) and non-primary buttons to their own gestures', () => {
    expect(press('title', [], { shiftKey: true })).toBeNull()
    expect(press('title', [], { button: 2 })).toBeNull()
    expect(press('title', [], { button: 1 })).toBeNull()
  })

  it('leaves the frame’s empty background to the marquee and the deselect click', () => {
    expect(press(ROOT)).toBeNull()
  })

  it('a selection made in another board frame sets no depth here', () => {
    expect(pressSelectionTarget(state(['title'], 'other-frame'), 'p', 'this-frame', 'label', left)).toBe('card')
  })
})
