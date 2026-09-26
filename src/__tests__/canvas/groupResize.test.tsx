/**
 * P5-F / IX-6g — resizing a multi-selection as one box.
 *
 * The pure half (`groupResize.ts`): the union box follows the single-element
 * rules and every member scales with it, about the union's origin. The hook
 * half (`useGroupResizeDrag`): one press on a group handle previews every
 * member and writes ONE `setNodesInlineStylesPerNode` on release.
 *
 * happy-dom has no layout, so member rects are stubbed on the elements and
 * every computed style comes from inline CSS.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { RESIZE_HANDLE_ATTR, RESIZE_HANDLES, type ResizeBoxStart } from '@core/studio-runtime'
import { useEditorStore } from '@site/store/store'
import { groupUnionRect, hasNestedMember, memberResizeStep, resizeGroupBox } from '@site/canvas/groupResize'
import { resizeFrameRect } from '@site/canvas/canvasSelectionOverlayPositioning'
import { useGroupResizeDrag } from '@site/canvas/useGroupResizeDrag'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const FREE = { proportional: false, fromCenter: false }

function flowStart(width: number, height: number): ResizeBoxStart {
  return { width, height, insetWidth: 0, insetHeight: 0, offsets: null }
}

describe('IX-6g — the group box', () => {
  it('is the union of the members, and resizes by the single-element rules', () => {
    const union = groupUnionRect([
      { x: 10, y: 10, width: 100, height: 50 },
      { x: 150, y: 30, width: 60, height: 80 },
    ])
    expect(union).toEqual({ x: 10, y: 10, width: 200, height: 100 })
    // E by +100: only the width grows; the west edge stays.
    expect(resizeGroupBox('e', union, 100, 40, FREE)).toEqual({ x: 10, y: 10, width: 300, height: 100 })
    // W by +50 (inwards): the east edge stays.
    expect(resizeGroupBox('w', union, 50, 0, FREE)).toEqual({ x: 60, y: 10, width: 150, height: 100 })
    // Shift on a corner keeps the union's ratio.
    expect(resizeGroupBox('se', union, 200, 0, { proportional: true, fromCenter: false })).toEqual({ x: 10, y: 10, width: 400, height: 200 })
  })

  it('the overlay places group handles on the union, and none when a member has no rect', () => {
    expect(resizeFrameRect([{ x: 0, y: 0, width: 10, height: 10 }])).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    expect(resizeFrameRect([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 30 }])).toEqual({ x: 0, y: 0, width: 30, height: 35 })
    expect(resizeFrameRect([{ x: 0, y: 0, width: 10, height: 10 }, null])).toBeNull()
  })
})

describe('IX-6g — a nested selection gets no group box', () => {
  const parents: Record<string, string | null> = { root: null, card: 'root', title: 'card', other: 'root' }
  const parentOf = (id: string) => parents[id] ?? null

  it('siblings and cousins are fine; a layer inside another selected one is not', () => {
    expect(hasNestedMember(parentOf, ['card', 'other'])).toBe(false)
    expect(hasNestedMember(parentOf, ['title', 'other'])).toBe(false)
    expect(hasNestedMember(parentOf, ['card', 'title'])).toBe(true)
  })
})

describe('IX-6g — every member scales with the box', () => {
  const union = { x: 0, y: 0, width: 200, height: 100 }
  const next = { x: 0, y: 0, width: 300, height: 100 }

  it('a flow member gets its size scaled, and no offset', () => {
    const step = memberResizeStep({ nodeId: 'a', rect: { x: 0, y: 0, width: 100, height: 50 }, start: flowStart(100, 50) }, union, next)
    expect(step).toEqual({ width: 150, height: 50, inline: null, top: null })
  })

  it('a content-box member writes its CSS width, not its border box', () => {
    const start: ResizeBoxStart = { width: 80, height: 30, insetWidth: 20, insetHeight: 20, offsets: null }
    const step = memberResizeStep({ nodeId: 'a', rect: { x: 0, y: 0, width: 100, height: 50 }, start }, union, next)
    expect(step.width).toBe(130)
    expect(step.height).toBe(30)
  })

  it('an absolute member keeps its relative place: its left scales about the union origin', () => {
    const start: ResizeBoxStart = { width: 50, height: 50, insetWidth: 0, insetHeight: 0, offsets: { inlineProperty: 'left', inline: 150, top: 20 } }
    const step = memberResizeStep({ nodeId: 'b', rect: { x: 150, y: 20, width: 50, height: 50 }, start }, union, next)
    // Left edge 150 → 225, width 50 → 75.
    expect(step).toEqual({ width: 75, height: 50, inline: 225, top: 20 })
  })

  it('an RTL member moves its inline-start (right side) offset by its right edge', () => {
    const start: ResizeBoxStart = { width: 50, height: 50, insetWidth: 0, insetHeight: 0, offsets: { inlineProperty: 'insetInlineStart', inline: 0, top: 20 } }
    const step = memberResizeStep({ nodeId: 'b', rect: { x: 150, y: 20, width: 50, height: 50 }, start }, union, next)
    // The right edge goes 200 → 300: the distance from the right side shrinks by 100.
    expect(step.inline).toBe(-100)
  })
})

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

let commits: Array<ReadonlyArray<{ nodeId: string; patch: Record<string, unknown> }>>
let frameDoc: Document
let handles: HTMLElement

function seed() {
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({
          id: 'home',
          slug: 'index',
          rootNodeId: 'root',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.container', children: ['a', 'b'] }),
            a: makeNode({ id: 'a', moduleId: 'base.container', parentId: 'root' }),
            b: makeNode({ id: 'b', moduleId: 'base.container', parentId: 'root' }),
          },
        }),
      ],
    }),
  )
  commits = []
  useEditorStore.setState({
    setNodesInlineStylesPerNode: (patches: ReadonlyArray<{ nodeId: string; patch: Record<string, unknown> }>) => {
      commits.push(patches)
    },
  } as Parameters<typeof useEditorStore.setState>[0])
}

function mount() {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  frameDoc = iframe.contentDocument!
  const parent = frameDoc.createElement('div')
  const member = (id: string, style: string, rect: DOMRect) => {
    const el = frameDoc.createElement('div')
    el.setAttribute('data-node-id', id)
    el.setAttribute('style', style)
    el.getBoundingClientRect = () => rect
    parent.appendChild(el)
    return el
  }
  member('a', 'box-sizing: border-box; width: 100px; height: 50px', { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0 } as DOMRect)
  member('b', 'box-sizing: border-box; width: 100px; height: 50px', { left: 100, top: 0, width: 100, height: 50, right: 200, bottom: 50, x: 100, y: 0 } as DOMRect)
  frameDoc.body.appendChild(parent)
  handles = frameDoc.createElement('div')
  for (const handle of RESIZE_HANDLES) {
    const el = frameDoc.createElement('div')
    el.setAttribute(RESIZE_HANDLE_ATTR, handle)
    handles.appendChild(el)
  }
  frameDoc.body.appendChild(handles)
}

function pointer(target: EventTarget, type: string, init: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { button: 0, buttons: 1, pointerId: 1, shiftKey: false, altKey: false, ...init })
  target.dispatchEvent(event)
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 40))

beforeEach(() => {
  useEditorStore.setState({ site: null, activePageId: null, canvasTool: 'move' } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  mock.restore()
})

describe('IX-6g — a group handle drag', () => {
  it('previews every member and commits them all in ONE call', async () => {
    seed()
    mount()
    renderHook(() => useGroupResizeDrag({ frame: handles, iframeDoc: frameDoc, nodeIdsKey: 'a b' }))
    pointer(handles.querySelector(`[${RESIZE_HANDLE_ATTR}="e"]`)!, 'pointerdown', { clientX: 200, clientY: 25 })
    pointer(frameDoc.body, 'pointermove', { clientX: 300, clientY: 25 })
    await frame()
    const a = frameDoc.querySelector<HTMLElement>('[data-node-id="a"]')!
    const b = frameDoc.querySelector<HTMLElement>('[data-node-id="b"]')!
    expect(a.style.width).toBe('150px')
    expect(b.style.width).toBe('150px')
    pointer(frameDoc.body, 'pointerup', { clientX: 300, clientY: 25, buttons: 0 })
    expect(commits).toEqual([[
      { nodeId: 'a', patch: { width: '150px' } },
      { nodeId: 'b', patch: { width: '150px' } },
    ]])
  })

  it('Escape cancels: previews restored, nothing written', async () => {
    seed()
    mount()
    renderHook(() => useGroupResizeDrag({ frame: handles, iframeDoc: frameDoc, nodeIdsKey: 'a b' }))
    pointer(handles.querySelector(`[${RESIZE_HANDLE_ATTR}="e"]`)!, 'pointerdown', { clientX: 200, clientY: 25 })
    pointer(frameDoc.body, 'pointermove', { clientX: 300, clientY: 25 })
    await frame()
    const event = new Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(event, { key: 'Escape', shiftKey: false, altKey: false })
    frameDoc.body.dispatchEvent(event)
    expect(frameDoc.querySelector<HTMLElement>('[data-node-id="a"]')!.style.width).toBe('100px')
    expect(commits).toEqual([])
  })
})
