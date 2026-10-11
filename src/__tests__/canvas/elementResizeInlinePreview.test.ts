/**
 * IX-6b — how a portal frame's resize preview gives the element back
 * (`elementResizeInlinePreview.ts`).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createInlineStylePreview } from '@site/canvas/elementResizeInlinePreview'

function mount(targetStyle: string): HTMLElement {
  const target = document.createElement('div')
  target.setAttribute('style', targetStyle)
  document.body.appendChild(target)
  return target
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('createInlineStylePreview', () => {
  it('restores every touched property to what it found, including one it cleared', () => {
    const target = mount('flex: 1 1 0; width: 200px')
    const preview = createInlineStylePreview(target)
    preview.apply({ flex: undefined, width: '240px' })
    expect(target.style.getPropertyValue('flex-grow')).toBe('')
    expect(target.style.width).toBe('240px')
    preview.clear()
    expect(target.style.getPropertyValue('flex-grow')).toBe('1')
    expect(target.style.width).toBe('200px')
  })

  it('restores a property a later step stopped writing', () => {
    const target = mount('width: 200px; height: 40px')
    const preview = createInlineStylePreview(target)
    preview.apply({ width: '240px', height: '48px' })
    preview.apply({ width: '250px' })
    expect(target.style.height).toBe('40px')
    expect(target.style.width).toBe('250px')
  })

  it('clears before it sets, so a cleared longhand cannot undo a set shorthand', () => {
    const target = mount('flex-grow: 2')
    const preview = createInlineStylePreview(target)
    preview.apply({ flex: '0 1 auto', flexGrow: undefined })
    expect(target.style.getPropertyValue('flex-grow')).toBe('0')
  })
})
