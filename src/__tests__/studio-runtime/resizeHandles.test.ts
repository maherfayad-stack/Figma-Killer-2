/**
 * The live (Tier 2) frame's own resize handles — `resizeHandles.ts`, the
 * runtime's half of the same gesture `useElementResizeDrag` runs for a portal
 * frame. Both hosts share `elementResizeRules.ts` and
 * `elementResizeMeasure.ts`, so these cases pin that the runtime actually
 * USES them: the commit it posts is the CSS size (IX-6a), a positioned
 * element's offset (IX-6d), live modifiers (IX-6c), the W×H badge (IX-18),
 * and the drag guard (ERR-12). happy-dom resolves the inline styles; the
 * preview is the runtime-owned stylesheet rule.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  RESIZE_ACTIVE_ATTR,
  RESIZE_HANDLE_ATTR,
  RESIZE_PREVIEW_STYLE_ID,
  RESIZE_SIZE_BADGE_ATTR,
  installResizeHandles,
  type ResizeCommitPatch,
  type ResizeHandlesController,
  type ResizeTargetContext,
  type SnapGuide,
} from '@core/studio-runtime'

let controller: ResizeHandlesController | null = null
let commits: ResizeCommitPatch[] = []
let guidePosts: Array<readonly SnapGuide[]> = []
let gestures: boolean[] = []

function install(
  targetStyle: string,
  options: { container?: HTMLElement; context?: ResizeTargetContext; peers?: Record<string, Element> } = {},
): { root: HTMLElement; target: HTMLElement } {
  const target = document.createElement('div')
  target.setAttribute('data-node-id', 'box')
  target.setAttribute('style', targetStyle)
  ;(options.container ?? document.body).appendChild(target)
  if (options.container && !options.container.isConnected) document.body.appendChild(options.container)
  const root = document.createElement('div')
  document.body.appendChild(root)
  commits = []
  guidePosts = []
  gestures = []
  controller = installResizeHandles({
    doc: document,
    view: window,
    ensureOverlayRoot: () => root,
    resolveTarget: (ref) => (ref.nodeId === 'box' ? target : (options.peers?.[ref.nodeId] ?? null)),
    onCommit: (_ref, patch) => commits.push(patch),
    onGuides: (guides) => guidePosts.push(guides),
    onGestureChange: (active) => gestures.push(active),
    onPreview: () => {},
  })
  controller.setTarget({ nodeId: 'box', occurrenceIndex: 0 }, false, options.context)
  return { root, target }
}

function pointer(target: EventTarget, type: string, init: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { button: 0, buttons: 1, pointerId: 1, shiftKey: false, altKey: false, clientX: 0, clientY: 0, ...init })
  target.dispatchEvent(event)
}

function handle(root: HTMLElement, name: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[${RESIZE_HANDLE_ATTR}="${name}"]`)!
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 40))

afterEach(() => {
  controller?.dispose()
  controller = null
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('installResizeHandles — the runtime drag', () => {
  it('commits the CSS width of a content-box element, not its border box (IX-6a)', () => {
    const { root } = install('box-sizing: content-box; width: 100px; height: 50px; padding: 10px; border: 1px solid black')
    pointer(handle(root, 'e'), 'pointerdown', {})
    pointer(document.body, 'pointermove', { clientX: 40 })
    pointer(document.body, 'pointerup', { clientX: 40, buttons: 0 })
    expect(commits).toEqual([{ width: '140px' }])
  })

  it('moves `left` with the W edge of an absolute element, and previews it (IX-6d)', async () => {
    const { root } = install('position: absolute; left: 50px; top: 30px; box-sizing: border-box; width: 100px; height: 60px')
    pointer(handle(root, 'w'), 'pointerdown', {})
    pointer(document.body, 'pointermove', { clientX: -20 })
    await frame()
    const rule = document.getElementById(RESIZE_PREVIEW_STYLE_ID)?.textContent ?? ''
    expect(rule).toContain('width: 120px !important')
    expect(rule).toContain('left: 30px !important')
    pointer(document.body, 'pointerup', { clientX: -20, buttons: 0 })
    expect(commits).toEqual([{ width: '120px', left: '30px' }])
  })

  it('reads ⇧ from a key press mid-drag (IX-6c)', () => {
    const { root } = install('box-sizing: border-box; width: 200px; height: 100px')
    pointer(handle(root, 'e'), 'pointerdown', {})
    pointer(document.body, 'pointermove', { clientX: 40 })
    const shift = new Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(shift, { key: 'Shift', shiftKey: true, altKey: false })
    document.body.dispatchEvent(shift)
    pointer(document.body, 'pointerup', { clientX: 40, buttons: 0 })
    expect(commits).toEqual([{ width: '240px', height: '120px' }])
  })

  it('shows the W×H badge only while dragging (IX-18)', () => {
    const { root } = install('box-sizing: border-box; width: 200px; height: 100px')
    const frameEl = root.firstElementChild as HTMLElement
    const badge = frameEl.querySelector(`[${RESIZE_SIZE_BADGE_ATTR}]`)!
    pointer(handle(root, 'e'), 'pointerdown', {})
    expect(frameEl.hasAttribute(RESIZE_ACTIVE_ATTR)).toBe(true)
    expect(badge.textContent).toBe('200 × 100')
    pointer(document.body, 'pointerup', { buttons: 0 })
    expect(frameEl.hasAttribute(RESIZE_ACTIVE_ATTR)).toBe(false)
  })

  it('finishes on a move with the button up, and abandons on a real blur (ERR-12)', async () => {
    const { root } = install('box-sizing: border-box; width: 200px; height: 100px')
    pointer(handle(root, 'e'), 'pointerdown', {})
    pointer(document.body, 'pointermove', { clientX: 40 })
    pointer(document.body, 'pointermove', { clientX: 90, buttons: 0 })
    expect(commits).toEqual([{ width: '240px' }])

    const hasFocus = spyOn(document, 'hasFocus').mockReturnValue(false)
    pointer(handle(root, 'e'), 'pointerdown', {})
    pointer(document.body, 'pointermove', { clientX: 10 })
    window.dispatchEvent(new Event('blur'))
    await frame()
    pointer(document.body, 'pointerup', { clientX: 10, buttons: 0 })
    expect(commits).toHaveLength(1)
    hasFocus.mockRestore()
  })
})

/** A flex row the target sits in — the layout whose main axis a `flex: 1` item does not let `width` decide. */
function flexRow(): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('style', 'display: flex; flex-direction: row; width: 600px')
  return row
}

/** Stub an element's border box — happy-dom lays nothing out. */
function placeAt(el: Element, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
}

describe('installResizeHandles — a flex item goes Fixed, as in a portal frame (canvas-23 / IX-6b)', () => {
  it('drops an inline `flex: 1` Fill marker with the width, and previews the cleared value', async () => {
    const { root } = install('flex: 1; width: 100px; height: 40px; box-sizing: border-box', {
      container: flexRow(),
      context: { sizing: { flex: '1' }, snap: null },
    })
    pointer(handle(root, 'e'), 'pointerdown', {})
    pointer(document.body, 'pointermove', { clientX: 40 })
    await frame()
    const rule = document.getElementById(RESIZE_PREVIEW_STYLE_ID)?.textContent ?? ''
    // Without the cleared flex the item keeps growing to fill the row and the
    // preview tracks nothing: `flex-grow` has to be beaten, not only `width`.
    expect(rule).toContain('flex-grow: 0 !important')
    expect(rule).toContain('width: 140px !important')
    pointer(document.body, 'pointerup', { clientX: 40, buttons: 0 })
    expect(commits).toEqual([{ flex: null, width: '140px' }])
  })

  it('overrides a `flex: 1` that lives in the cascade, which no clear could reach', () => {
    const style = document.createElement('style')
    style.textContent = '.grow { flex: 1 1 0%; }'
    document.head.appendChild(style)
    const { root, target } = install('width: 100px; height: 40px; box-sizing: border-box', { container: flexRow(), context: { sizing: {}, snap: null } })
    target.className = 'grow'
    pointer(handle(root, 'e'), 'pointerdown', {})
    pointer(document.body, 'pointermove', { clientX: 40 })
    pointer(document.body, 'pointerup', { clientX: 40, buttons: 0 })
    expect(commits).toEqual([{ flex: '0 1 auto', width: '140px' }])
  })
})

describe('installResizeHandles — the moving edge snaps, as in a portal frame (canvas-26 / IX-6e)', () => {
  it('snaps the east edge to a sibling within the zoomed threshold, and reports the guide', async () => {
    const sibling = document.createElement('div')
    document.body.appendChild(sibling)
    placeAt(sibling, 110, 0, 100, 50)
    const { root, target } = install('width: 100px; height: 50px; box-sizing: border-box', {
      context: { sizing: {}, snap: { siblings: [{ nodeId: 'sibling', occurrenceIndex: 0 }], parent: null, zoom: 1 } },
      peers: { sibling },
    })
    placeAt(target, 0, 0, 100, 50)
    pointer(handle(root, 'e'), 'pointerdown', {})
    // The edge lands at 157 — 3 px short of the sibling's centre (160).
    pointer(document.body, 'pointermove', { clientX: 57 })
    await frame()
    expect(guidePosts.at(-1)).toEqual([{ axis: 'x', position: 160, start: 0, end: 50 }])
    pointer(document.body, 'pointerup', { clientX: 57, buttons: 0 })
    expect(commits).toEqual([{ width: '160px' }])
    // The guides are cleared once the drag ends.
    expect(guidePosts.at(-1)).toEqual([])
  })

  it('pulls from 8 SCREEN px: at 50% zoom a 12 frame-px gap still snaps', () => {
    const sibling = document.createElement('div')
    document.body.appendChild(sibling)
    placeAt(sibling, 110, 0, 100, 50)
    const { root, target } = install('width: 100px; height: 50px; box-sizing: border-box', {
      context: { sizing: {}, snap: { siblings: [{ nodeId: 'sibling', occurrenceIndex: 0 }], parent: null, zoom: 0.5 } },
      peers: { sibling },
    })
    placeAt(target, 0, 0, 100, 50)
    pointer(handle(root, 'e'), 'pointerdown', {})
    pointer(document.body, 'pointermove', { clientX: 98 })
    pointer(document.body, 'pointerup', { clientX: 98, buttons: 0 })
    // The edge at 198 is 12 frame px from the sibling's end (210): 6 screen px at 50%.
    expect(commits).toEqual([{ width: '210px' }])
  })
})

describe('installResizeHandles — the drag is a gesture (canvas-23, the badge at the bottom of a live frame)', () => {
  it('reports the gesture start at pointerdown and its end on release and on cancel', () => {
    const { root } = install('box-sizing: border-box; width: 200px; height: 100px')
    pointer(handle(root, 'e'), 'pointerdown', {})
    expect(gestures).toEqual([true])
    pointer(document.body, 'pointerup', { clientX: 20, buttons: 0 })
    expect(gestures).toEqual([true, false])
    pointer(handle(root, 'e'), 'pointerdown', {})
    pointer(document.body, 'pointercancel', {})
    expect(gestures).toEqual([true, false, true, false])
  })
})
