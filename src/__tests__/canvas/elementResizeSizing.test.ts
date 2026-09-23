/**
 * IX-6b — what a canvas resize writes besides the size, and how its preview
 * gives the element back.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  createInlineStylePreview,
  cssPropertyName,
  planResizeSizing,
  readSizingParentLayout,
  resizeInlinePatch,
} from '@site/canvas/elementResizeSizing'
import type { ResizeBoxStart } from '@core/studio-runtime'

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

describe('createInlineStylePreview', () => {
  it('restores every touched property to what it found, including one it cleared', () => {
    const target = mount('', 'flex: 1 1 0; width: 200px')
    const preview = createInlineStylePreview(target)
    preview.apply({ flex: undefined, width: '240px' })
    expect(target.style.getPropertyValue('flex-grow')).toBe('')
    expect(target.style.width).toBe('240px')
    preview.clear()
    expect(target.style.getPropertyValue('flex-grow')).toBe('1')
    expect(target.style.width).toBe('200px')
  })

  it('restores a property a later step stopped writing', () => {
    const target = mount('', 'width: 200px; height: 40px')
    const preview = createInlineStylePreview(target)
    preview.apply({ width: '240px', height: '48px' })
    preview.apply({ width: '250px' })
    expect(target.style.height).toBe('40px')
    expect(target.style.width).toBe('250px')
  })

  it('clears before it sets, so a cleared longhand cannot undo a set shorthand', () => {
    const target = mount('', 'flex-grow: 2')
    const preview = createInlineStylePreview(target)
    preview.apply({ flex: '0 1 auto', flexGrow: undefined })
    expect(target.style.getPropertyValue('flex-grow')).toBe('0')
  })
})

describe('cssPropertyName', () => {
  it('spells a style key the way the CSSOM takes it', () => {
    expect(cssPropertyName('alignSelf')).toBe('align-self')
    expect(cssPropertyName('insetInlineStart')).toBe('inset-inline-start')
    expect(cssPropertyName('width')).toBe('width')
  })
})
