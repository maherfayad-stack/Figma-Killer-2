/**
 * P2-D — the portal-mode element resize, at the layer the gesture lives at
 * (the hook), because the canvas DOM is inside an iframe and a component-level
 * test could not press a handle (`iframeCanvasQuery.ts`).
 *
 * Each case pins one audited defect (`docs/audits/2026-09-23-studio-audit/`):
 *
 *   - IX-6a  a `content-box` element grew by its padding + border, because the
 *            border-box RECT was written as the CSS `width`;
 *   - IX-6b  a flex item's `flex: 1` swallowed the dragged width — the handles
 *            tracked the cursor and the element snapped back on release;
 *   - IX-6c  ⇧ was ignored (only the K tool, latched at pointerdown) and ⌥ did
 *            nothing;
 *   - IX-6d  the W handle of an absolute element grew it to the RIGHT;
 *   - IX-18  no W×H readout while sizing;
 *   - ERR-12 a release the frame never heard left the drag running, and a
 *            window blur resumed it against the next pointer.
 *
 * happy-dom has no layout, so every size the hook READS comes from inline
 * styles (which `getComputedStyle` resolves) and every size it WRITES is read
 * back off the element's own `style` and the one store call it makes. The
 * computed-layout half of the same claims is `tests/e2e/element-resize.e2e.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useElementResizeDrag } from '@site/canvas/useElementResizeDrag'
import { RESIZE_ACTIVE_ATTR, RESIZE_HANDLE_ATTR, RESIZE_HANDLES, RESIZE_SIZE_BADGE_ATTR } from '@core/studio-runtime'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

interface Harness {
  frameDoc: Document
  target: HTMLElement
  handles: HTMLElement
}

let harness: Harness
let commits: Array<Record<string, unknown>>

function seed(inlineStyles?: Record<string, string>) {
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({
          id: 'home',
          slug: 'index',
          rootNodeId: 'root',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.container', children: ['box'] }),
            box: makeNode({ id: 'box', moduleId: 'base.container', parentId: 'root', inlineStyles }),
          },
        }),
      ],
    }),
  )
  commits = []
  useEditorStore.setState({
    setNodeInlineStyles: (_id: string, patch: Record<string, unknown>) => {
      commits.push(patch)
    },
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** `parentStyle` / `targetStyle` are inline CSS text — the only styles happy-dom resolves without layout. */
function mount(targetStyle: string, parentStyle = ''): Harness {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const frameDoc = iframe.contentDocument!
  const parent = frameDoc.createElement('div')
  parent.setAttribute('style', parentStyle)
  const target = frameDoc.createElement('div')
  target.setAttribute('data-node-id', 'box')
  target.setAttribute('style', targetStyle)
  parent.appendChild(target)
  frameDoc.body.appendChild(parent)

  const handles = frameDoc.createElement('div')
  for (const handle of RESIZE_HANDLES) {
    const el = frameDoc.createElement('div')
    el.setAttribute(RESIZE_HANDLE_ATTR, handle)
    handles.appendChild(el)
  }
  const badge = frameDoc.createElement('div')
  badge.setAttribute(RESIZE_SIZE_BADGE_ATTR, 'true')
  handles.appendChild(badge)
  frameDoc.body.appendChild(handles)
  return { frameDoc, target, handles }
}

function render() {
  return renderHook(() => useElementResizeDrag({ frame: harness.handles, iframeDoc: harness.frameDoc, nodeId: 'box' }))
}

function pointer(target: EventTarget, type: string, init: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { button: 0, buttons: 1, pointerId: 1, shiftKey: false, altKey: false, ...init })
  target.dispatchEvent(event)
}

function press(handle: string, x = 0, y = 0, init: Record<string, unknown> = {}) {
  const el = harness.handles.querySelector(`[${RESIZE_HANDLE_ATTR}="${handle}"]`)!
  pointer(el, 'pointerdown', { clientX: x, clientY: y, ...init })
}

function moveTo(x: number, y: number, init: Record<string, unknown> = {}) {
  pointer(harness.frameDoc.body, 'pointermove', { clientX: x, clientY: y, ...init })
}

function release(x: number, y: number) {
  pointer(harness.frameDoc.body, 'pointerup', { clientX: x, clientY: y, buttons: 0 })
}

function key(type: 'keydown' | 'keyup', keyName: string, init: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { key: keyName, shiftKey: false, altKey: false, ...init })
  harness.frameDoc.body.dispatchEvent(event)
}

/** The drag writes its preview once per animation frame. */
const frame = () => new Promise((resolve) => setTimeout(resolve, 40))

beforeEach(() => {
  useEditorStore.setState({ site: null, activePageId: null, canvasTool: 'move' } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  mock.restore()
})

describe('IX-6a — the CSS width, not the rect', () => {
  it('a content-box element grows by exactly the drag, not by its padding + border too', async () => {
    seed()
    harness = mount('box-sizing: content-box; width: 100px; height: 50px; padding: 10px; border: 1px solid black')
    // The border box a rect read would have seen.
    harness.target.getBoundingClientRect = () => ({ width: 122, height: 72, left: 0, top: 0, right: 122, bottom: 72, x: 0, y: 0 }) as DOMRect
    render()
    press('e')
    moveTo(40, 0)
    await frame()
    expect(harness.target.style.width).toBe('140px')
    release(40, 0)
    expect(commits).toEqual([{ width: '140px' }])
  })

  it('a border-box element writes the box it shows', async () => {
    seed()
    harness = mount('box-sizing: border-box; width: 122px; height: 72px; padding: 10px')
    render()
    press('e')
    moveTo(40, 0)
    release(40, 0)
    expect(commits).toEqual([{ width: '162px' }])
  })
})

describe('IX-6b — a flex item goes Fixed through the inspector resolver', () => {
  it('drops the `flex: 1` Fill marker in the preview AND the commit, so the width renders', async () => {
    seed({ flex: '1 1 0' })
    harness = mount('flex: 1 1 0; width: 200px; height: 40px', 'display: flex; flex-direction: row')
    render()
    press('e')
    moveTo(40, 0)
    await frame()
    // The preview says what the commit will: no flex, a width.
    expect(harness.target.style.getPropertyValue('flex')).toBe('')
    expect(harness.target.style.width).toBe('240px')
    release(40, 0)
    expect(commits).toEqual([{ flex: null, width: '240px' }])
    // Restored before the store commit — React's re-render is the last writer.
    expect(harness.target.style.getPropertyValue('flex-grow')).toBe('1')
  })

  it('writes the size alone in a block parent', async () => {
    seed({ flex: '1 1 0' })
    harness = mount('width: 200px; height: 40px', 'display: block')
    render()
    press('e')
    moveTo(40, 0)
    release(40, 0)
    expect(commits).toEqual([{ width: '240px' }])
  })
})

describe('IX-6c — ⇧ and ⌥ are read live', () => {
  it('pressing ⇧ mid-drag locks the ratio without another move, and releasing it lets go', async () => {
    seed()
    harness = mount('box-sizing: border-box; width: 200px; height: 100px')
    render()
    press('e')
    moveTo(40, 0)
    await frame()
    expect(harness.target.style.height).toBe('100px')
    key('keydown', 'Shift', { shiftKey: true })
    await frame()
    expect(harness.target.style.width).toBe('240px')
    expect(harness.target.style.height).toBe('120px')
    key('keyup', 'Shift', { shiftKey: false })
    await frame()
    expect(harness.target.style.height).toBe('100px')
    release(40, 0)
    expect(commits).toEqual([{ width: '240px' }])
  })

  it('⇧ held on a move keeps the ratio', () => {
    seed()
    harness = mount('box-sizing: border-box; width: 200px; height: 100px')
    render()
    press('e')
    moveTo(100, 0, { shiftKey: true })
    release(100, 0)
    expect(commits).toEqual([{ width: '300px', height: '150px' }])
  })

  it('⌥ resizes from the centre — the delta counts twice', () => {
    seed()
    harness = mount('box-sizing: border-box; width: 200px; height: 100px')
    render()
    press('e')
    moveTo(40, 0, { altKey: true })
    release(40, 0)
    expect(commits).toEqual([{ width: '280px' }])
  })
})

describe('IX-6d — an absolute element keeps its opposite edge', () => {
  it('the W handle moves `left` with the edge', () => {
    seed()
    harness = mount('position: absolute; left: 50px; top: 30px; box-sizing: border-box; width: 100px; height: 60px')
    render()
    press('w')
    moveTo(-20, 0)
    release(-20, 0)
    expect(commits).toEqual([{ width: '120px', left: '30px' }])
  })

  it('the N handle moves `top` with the edge', () => {
    seed()
    harness = mount('position: absolute; left: 50px; top: 30px; box-sizing: border-box; width: 100px; height: 60px')
    render()
    press('n')
    moveTo(0, 10)
    release(0, 10)
    expect(commits).toEqual([{ height: '50px', top: '40px' }])
  })
})

describe('IX-18 — the W×H badge', () => {
  it('shows for the length of the drag, seeded with the visible box', () => {
    seed()
    harness = mount('box-sizing: content-box; width: 100px; height: 50px; padding: 10px; border: 1px solid black')
    render()
    const badge = harness.handles.querySelector(`[${RESIZE_SIZE_BADGE_ATTR}]`)!
    expect(harness.handles.hasAttribute(RESIZE_ACTIVE_ATTR)).toBe(false)
    press('e')
    expect(harness.handles.hasAttribute(RESIZE_ACTIVE_ATTR)).toBe(true)
    expect(badge.textContent).toBe('122 × 72')
    release(0, 0)
    expect(harness.handles.hasAttribute(RESIZE_ACTIVE_ATTR)).toBe(false)
  })
})

describe('ERR-12 — a drag nobody finished', () => {
  it('a move with the button up commits at the last point, once, and the drag is over', async () => {
    seed()
    harness = mount('box-sizing: border-box; width: 200px; height: 100px')
    render()
    press('e')
    moveTo(40, 0)
    // The release happened over something this document never heard from.
    moveTo(90, 0, { buttons: 0 })
    expect(commits).toEqual([{ width: '240px' }])
    moveTo(150, 0)
    await frame()
    expect(commits).toHaveLength(1)
    expect(harness.target.style.width).toBe('200px')
  })

  it('a window blur abandons the drag: nothing committed, the preview restored', async () => {
    seed()
    harness = mount('box-sizing: border-box; width: 200px; height: 100px')
    render()
    const hasFocus = spyOn(document, 'hasFocus').mockReturnValue(false)
    press('e')
    moveTo(40, 0)
    await frame()
    expect(harness.target.style.width).toBe('240px')
    window.dispatchEvent(new Event('blur'))
    await frame()
    expect(commits).toEqual([])
    expect(harness.target.style.width).toBe('200px')
    hasFocus.mockRestore()
  })

  it('Escape cancels and restores', async () => {
    seed()
    harness = mount('box-sizing: border-box; width: 200px; height: 100px')
    render()
    press('e')
    moveTo(40, 0)
    await frame()
    key('keydown', 'Escape', {})
    expect(commits).toEqual([])
    expect(harness.target.style.width).toBe('200px')
  })
})

describe('the click that ends a drag stays on the handle', () => {
  it('never reaches the page body, so the sized element stays selected', () => {
    seed()
    harness = mount('box-sizing: border-box; width: 200px; height: 100px')
    render()
    const reached: string[] = []
    harness.frameDoc.body.addEventListener('click', () => reached.push('body'), true)
    const handle = harness.handles.querySelector(`[${RESIZE_HANDLE_ATTR}="w"]`)!
    handle.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    handle.dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true }))
    expect(reached).toEqual([])
    // A click on the page itself is untouched.
    harness.target.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    expect(reached).toEqual(['body'])
  })
})

// ---------------------------------------------------------------------------
// P2-E / IX-6e — the moving edge snaps to its siblings and its parent
// ---------------------------------------------------------------------------

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect
}

/**
 * `box` and a sibling `peer` inside `root`. happy-dom has no layout, so every
 * rect the snap reads is stubbed: the parent 0..300 × 0..200 with 20px
 * padding, the sibling's right edge at 120.
 */
function mountWithPeer(targetStyle: string, targetRect: DOMRect, parentStyle = 'padding: 20px') {
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({
          id: 'home',
          slug: 'index',
          rootNodeId: 'root',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.container', children: ['box', 'peer'] }),
            box: makeNode({ id: 'box', moduleId: 'base.container', parentId: 'root' }),
            peer: makeNode({ id: 'peer', moduleId: 'base.container', parentId: 'root' }),
          },
        }),
      ],
    }),
  )
  commits = []
  useEditorStore.setState({
    setNodeInlineStyles: (_id: string, patch: Record<string, unknown>) => {
      commits.push(patch)
    },
  } as Parameters<typeof useEditorStore.setState>[0])
  harness = mount(targetStyle, parentStyle)
  const parent = harness.target.parentElement!
  parent.setAttribute('data-node-id', 'root')
  parent.getBoundingClientRect = () => rectOf(0, 0, 300, 200)
  const peer = harness.frameDoc.createElement('div')
  peer.setAttribute('data-node-id', 'peer')
  peer.getBoundingClientRect = () => rectOf(20, 100, 100, 40)
  parent.appendChild(peer)
  harness.target.getBoundingClientRect = () => targetRect
}

describe('IX-6e — a resize handle snaps its moving edge', () => {
  it('E lands on a sibling edge within the threshold, and the source gets that width', () => {
    // box: 20..116; the sibling's right edge is 120. A 0 → +2 drag leaves the
    // edge at 118, 2px short — it snaps the last 2px.
    mountWithPeer('box-sizing: border-box; width: 96px; height: 40px', rectOf(20, 20, 96, 40))
    render()
    press('e')
    moveTo(2, 0)
    release(2, 0)
    expect(commits).toEqual([{ width: '100px' }])
  })

  it('E snaps to the parent content box edge (IX-5b for resize)', () => {
    // The parent's content box ends at 300 - 20 = 280. From 116, +160 → 276.
    mountWithPeer('box-sizing: border-box; width: 96px; height: 40px', rectOf(20, 20, 96, 40))
    render()
    press('e')
    moveTo(160, 0)
    release(160, 0)
    expect(commits).toEqual([{ width: '260px' }])
  })

  it('beyond the threshold the pointer rules', () => {
    mountWithPeer('box-sizing: border-box; width: 96px; height: 40px', rectOf(20, 20, 96, 40))
    render()
    press('e')
    // Edge at 176: nothing within 8px (the parent's centre is 150, its
    // content edge 280, the sibling's edges 20 / 70 / 120).
    moveTo(60, 0)
    release(60, 0)
    expect(commits).toEqual([{ width: '156px' }])
  })

  it('an absolute element snaps its W edge, and `left` follows the snapped edge', () => {
    // box: 150..250 inside a relative parent; the sibling's right edge is 120.
    // A -27 drag puts the W edge at 123 — it snaps to 120.
    mountWithPeer(
      'position: absolute; left: 150px; top: 20px; box-sizing: border-box; width: 100px; height: 40px',
      rectOf(150, 20, 100, 40),
      'position: relative; padding: 20px',
    )
    render()
    press('w')
    moveTo(-27, 0)
    release(-27, 0)
    expect(commits).toEqual([{ width: '130px', left: '120px' }])
  })

  it('a flow element W handle does not snap — its W edge is not what moves', () => {
    mountWithPeer('box-sizing: border-box; width: 96px; height: 40px', rectOf(150, 20, 96, 40))
    render()
    press('w')
    moveTo(-27, 0)
    release(-27, 0)
    expect(commits).toEqual([{ width: '123px' }])
  })

  it('⌥ (from the centre) does not snap: both edges move', () => {
    mountWithPeer('box-sizing: border-box; width: 96px; height: 40px', rectOf(20, 20, 96, 40))
    render()
    press('e')
    // Snapped, the edge (117) would pull to 120 and the doubled delta make 104.
    moveTo(1, 0, { altKey: true })
    release(1, 0)
    expect(commits).toEqual([{ width: '98px' }])
  })
})
