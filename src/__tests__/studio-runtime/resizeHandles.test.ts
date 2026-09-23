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
  type ElementResizePatch,
  type ResizeHandlesController,
} from '@core/studio-runtime'

let controller: ResizeHandlesController | null = null
let commits: ElementResizePatch[] = []

function install(targetStyle: string): { root: HTMLElement; target: HTMLElement } {
  const target = document.createElement('div')
  target.setAttribute('data-node-id', 'box')
  target.setAttribute('style', targetStyle)
  document.body.appendChild(target)
  const root = document.createElement('div')
  document.body.appendChild(root)
  commits = []
  controller = installResizeHandles({
    doc: document,
    view: window,
    ensureOverlayRoot: () => root,
    resolveTarget: () => target,
    onCommit: (_ref, patch) => commits.push(patch),
    onPreview: () => {},
  })
  controller.setTarget({ nodeId: 'box', occurrenceIndex: 0 }, false)
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
