/**
 * P5-F / IX-25 — rotating the selected element from just outside a corner.
 *
 * Pure half: the angle about the centre, ⇧'s 15° steps, the refusals, and the
 * `rotate` value model the inspector shares (`rotateValue.ts`). Hook half: a
 * drag previews the standalone `rotate` on the element and commits ONE
 * `setNodeInlineStyles({ rotate })` — never `transform`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { ROTATE_CORNERS, ROTATE_HANDLE_ATTR } from '@core/studio-runtime'
import { useEditorStore } from '@site/store/store'
import { rotateRefusal, rotationAt, useElementRotateDrag } from '@site/canvas/useElementRotateDrag'
import { normalizeDegrees, parseRotateDegrees, rotateDeclaration } from '@site/panels/PropertiesPanel/rotateValue'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

describe('IX-25 — the rotate value model', () => {
  it('reads plain angles in every unit, and refuses 3D axes and variables', () => {
    expect(parseRotateDegrees(undefined)).toBe(0)
    expect(parseRotateDegrees('none')).toBe(0)
    expect(parseRotateDegrees('30deg')).toBe(30)
    expect(parseRotateDegrees('0.25turn')).toBe(90)
    expect(parseRotateDegrees('z 45deg')).toBe(45)
    expect(parseRotateDegrees('100grad')).toBe(90)
    expect(parseRotateDegrees('x 45deg')).toBeNull()
    expect(parseRotateDegrees('var(--spin)')).toBeNull()
  })

  it('folds into (-180, 180] and clears at zero', () => {
    expect(normalizeDegrees(190)).toBe(-170)
    expect(normalizeDegrees(-180)).toBe(180)
    expect(normalizeDegrees(720.04)).toBe(0)
    expect(rotateDeclaration(360)).toBeNull()
    expect(rotateDeclaration(12.34)).toBe('12.3deg')
  })
})

describe('IX-25 — the angle', () => {
  const center = { x: 0, y: 0 }

  it('is the pointer\'s turn about the centre, added to the rotation it had', () => {
    // From due east to due south is +90° (screen y grows downwards).
    expect(rotationAt(center, { x: 10, y: 0 }, { x: 0, y: 10 }, 0, false)).toBe(90)
    expect(rotationAt(center, { x: 10, y: 0 }, { x: 0, y: 10 }, 30, false)).toBe(120)
  })

  it('Shift snaps to 15° steps', () => {
    const to = { x: Math.cos((37 * Math.PI) / 180) * 10, y: Math.sin((37 * Math.PI) / 180) * 10 }
    expect(rotationAt(center, { x: 10, y: 0 }, to, 0, false)).toBe(37)
    expect(rotationAt(center, { x: 10, y: 0 }, to, 0, true)).toBe(30)
  })
})

describe('IX-25 — refused, with a reason', () => {
  it('a rotation inside transform is not stacked on', () => {
    expect(rotateRefusal({ transform: 'rotate(10deg)' }, { rotate: 'none', transform: 'none' })).toMatch(/transform/)
  })

  it('an authored non-rotate transform survives: rotation is allowed', () => {
    expect(rotateRefusal({ transform: 'translateX(4px)' }, { rotate: 'none', transform: 'matrix(1,0,0,1,4,0)' })).toBeNull()
  })

  it('a 3D rotate value is not continued', () => {
    expect(rotateRefusal({ rotate: 'x 20deg' }, { rotate: 'x 20deg', transform: 'none' })).toMatch(/3D/)
  })
})

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

let commits: Array<{ nodeId: string; patch: Record<string, unknown> }>
let frameDoc: Document
let zones: HTMLElement

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
    setNodeInlineStyles: (nodeId: string, patch: Record<string, unknown>) => {
      commits.push({ nodeId, patch })
    },
  } as Parameters<typeof useEditorStore.setState>[0])
}

function mount(style: string) {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  frameDoc = iframe.contentDocument!
  const target = frameDoc.createElement('div')
  target.setAttribute('data-node-id', 'box')
  target.setAttribute('style', style)
  target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect
  frameDoc.body.appendChild(target)
  zones = frameDoc.createElement('div')
  for (const corner of ROTATE_CORNERS) {
    const el = frameDoc.createElement('div')
    el.setAttribute(ROTATE_HANDLE_ATTR, corner)
    zones.appendChild(el)
  }
  frameDoc.body.appendChild(zones)
  return target
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

describe('IX-25 — a rotation drag', () => {
  it('previews the standalone rotate and commits it once', async () => {
    seed()
    const target = mount('width: 100px; height: 100px')
    renderHook(() => useElementRotateDrag({ frame: zones, iframeDoc: frameDoc, nodeId: 'box' }))
    // Centre (50, 50). From the SE corner's outside (110, 110) to straight
    // below the centre (50, 130): the pointer turns +45°.
    pointer(zones.querySelector(`[${ROTATE_HANDLE_ATTR}="se"]`)!, 'pointerdown', { clientX: 110, clientY: 110 })
    pointer(frameDoc.body, 'pointermove', { clientX: 50, clientY: 130 })
    await frame()
    expect(target.style.getPropertyValue('rotate')).toBe('45deg')
    expect(target.style.transform).toBe('')
    pointer(frameDoc.body, 'pointerup', { clientX: 50, clientY: 130, buttons: 0 })
    expect(commits).toEqual([{ nodeId: 'box', patch: { rotate: '45deg' } }])
  })

  it('continues from the rotation the layer already has', async () => {
    seed({ rotate: '30deg' })
    mount('width: 100px; height: 100px; rotate: 30deg')
    renderHook(() => useElementRotateDrag({ frame: zones, iframeDoc: frameDoc, nodeId: 'box' }))
    pointer(zones.querySelector(`[${ROTATE_HANDLE_ATTR}="se"]`)!, 'pointerdown', { clientX: 110, clientY: 110 })
    pointer(frameDoc.body, 'pointermove', { clientX: 50, clientY: 130 })
    pointer(frameDoc.body, 'pointerup', { clientX: 50, clientY: 130, buttons: 0 })
    expect(commits).toEqual([{ nodeId: 'box', patch: { rotate: '75deg' } }])
  })

  it('a press with no turn writes nothing', () => {
    seed()
    mount('width: 100px; height: 100px')
    renderHook(() => useElementRotateDrag({ frame: zones, iframeDoc: frameDoc, nodeId: 'box' }))
    pointer(zones.querySelector(`[${ROTATE_HANDLE_ATTR}="nw"]`)!, 'pointerdown', { clientX: -10, clientY: -10 })
    pointer(frameDoc.body, 'pointerup', { clientX: -10, clientY: -10, buttons: 0 })
    expect(commits).toEqual([])
  })

  it('refuses a layer rotated inside its transform: no preview, no write', async () => {
    seed({ transform: 'rotate(10deg)' })
    const target = mount('width: 100px; height: 100px')
    renderHook(() => useElementRotateDrag({ frame: zones, iframeDoc: frameDoc, nodeId: 'box' }))
    pointer(zones.querySelector(`[${ROTATE_HANDLE_ATTR}="se"]`)!, 'pointerdown', { clientX: 110, clientY: 110 })
    pointer(frameDoc.body, 'pointermove', { clientX: 50, clientY: 130 })
    await frame()
    pointer(frameDoc.body, 'pointerup', { clientX: 50, clientY: 130, buttons: 0 })
    expect(target.style.getPropertyValue('rotate')).toBe('')
    expect(commits).toEqual([])
  })
})
