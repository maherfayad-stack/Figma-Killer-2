/**
 * IX-6b — what a canvas resize writes besides the size, for both hosts: the
 * portal drag and the live frame's own handles. The portal's inline preview
 * is `elementResizeInlinePreview.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  cssPropertyName,
  planResizeSizing,
  readClearedValues,
  readSizingParentLayout,
  resizeInlinePatch,
  stylesheetPreviewDeclarations,
  type ResizeBoxStart,
} from '@core/studio-runtime'

const FLOW: ResizeBoxStart = { width: 200, height: 40, insetWidth: 0, insetHeight: 0, offsets: null }

function mount(parentStyle: string, targetStyle: string, wrapper?: string): HTMLElement {
  const parent = document.createElement('div')
  parent.setAttribute('style', parentStyle)
  const target = document.createElement('div')
  target.setAttribute('style', targetStyle)
  if (wrapper) {
    const host = document.createElement('div')
    host.setAttribute('style', wrapper)
    host.appendChild(target)
    parent.appendChild(host)
  } else {
    parent.appendChild(target)
  }
  document.body.appendChild(parent)
  return target
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('readSizingParentLayout', () => {
  it('skips a `display: contents` host to the container that lays the element out', () => {
    const target = mount('display: flex; flex-direction: column', '', 'display: contents')
    expect(readSizingParentLayout(window, target)).toEqual({ display: 'flex', flexDirection: 'column' })
  })
})

describe('planResizeSizing + resizeInlinePatch', () => {
  it('carries the flex main axis companion only when that axis is written', () => {
    const target = mount('display: flex; flex-direction: row', 'flex: 1 1 0; width: 200px')
    const plan = planResizeSizing(window, target, FLOW, { flex: '1 1 0' })
    // Width moved: the Fill marker goes with it.
    expect(resizeInlinePatch(FLOW, { width: 240, height: 40, inline: null, top: null }, plan)).toEqual({
      flex: undefined,
      width: '240px',
    })
    // Only the height (the cross axis) moved: the width's Fill is left alone.
    expect(resizeInlinePatch(FLOW, { width: 200, height: 60, inline: null, top: null }, plan)).toEqual({
      height: '60px',
    })
  })

  it('leaves the element exactly as it found it after the probe', () => {
    const target = mount('display: flex', 'flex: 1 1 0; width: 200px')
    planResizeSizing(window, target, FLOW, { flex: '1 1 0' })
    expect(target.style.getPropertyValue('flex-grow')).toBe('1')
  })

  it('gives a positioned element no companions — it has no flex role', () => {
    const target = mount('display: flex', 'position: absolute; flex: 1 1 0')
    const positioned = { ...FLOW, offsets: { inlineProperty: 'left' as const, inline: 0, top: 0 } }
    expect(planResizeSizing(window, target, positioned, { flex: '1 1 0' })).toEqual({ width: {}, height: {} })
  })
})

describe('readClearedValues + stylesheetPreviewDeclarations — a stylesheet preview of a clear', () => {
  it('spells a cleared `flex` as the longhands the cascade gives without the inline one', () => {
    const target = mount('display: flex; flex-direction: row', 'flex: 1 1 0; width: 200px')
    const plan = planResizeSizing(window, target, FLOW, { flex: '1 1 0' })
    const cleared = readClearedValues(window, target, plan)
    expect(cleared).toEqual({ 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto' })
    // The probe gave the element back.
    expect(target.style.getPropertyValue('flex-grow')).toBe('1')
    const patch = resizeInlinePatch(FLOW, { width: 240, height: 40, inline: null, top: null }, plan)!
    expect(stylesheetPreviewDeclarations(patch, cleared)).toEqual([
      ['flex-grow', '0'],
      ['flex-shrink', '1'],
      ['flex-basis', 'auto'],
      ['width', '240px'],
    ])
  })

  it('reads nothing when the plan clears nothing', () => {
    const target = mount('display: block', 'width: 200px')
    expect(readClearedValues(window, target, planResizeSizing(window, target, FLOW, {}))).toEqual({})
  })
})

describe('cssPropertyName', () => {
  it('spells a style key the way the CSSOM takes it', () => {
    expect(cssPropertyName('alignSelf')).toBe('align-self')
    expect(cssPropertyName('insetInlineStart')).toBe('inset-inline-start')
    expect(cssPropertyName('width')).toBe('width')
  })
})
