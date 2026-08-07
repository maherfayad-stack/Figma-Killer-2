import { describe, expect, it } from 'bun:test'
import {
  isPropWritableToSource,
  isStyleWritableToSource,
  styleValueKey,
  canWriteInlineStyleForModule,
} from '../sourceWritability'

describe('canWriteInlineStyleForModule', () => {
  it('is writable for base.* modules', () => {
    expect(canWriteInlineStyleForModule('base.container')).toBe(true)
    expect(canWriteInlineStyleForModule('base.text')).toBe(true)
  })

  it('is unwritable for pkg.*, alm.*, and studio.instance modules', () => {
    expect(canWriteInlineStyleForModule('pkg.acme-button')).toBe(false)
    expect(canWriteInlineStyleForModule('alm.card')).toBe(false)
    expect(canWriteInlineStyleForModule('studio.instance')).toBe(false)
  })
})

describe('isStyleWritableToSource (per-property inline-style lock)', () => {
  it('is writable when the node has no codeProps at all', () => {
    expect(isStyleWritableToSource({}, 'width')).toBe(true)
  })

  it('is unwritable when the property is namespaced in codeProps', () => {
    const node = { codeProps: [styleValueKey('width')] }
    expect(isStyleWritableToSource(node, 'width')).toBe(false)
    expect(isStyleWritableToSource(node, 'height')).toBe(true)
  })

  it('does not confuse an ordinary prop lock with a style lock of the same name', () => {
    // `codeProps: ['width']` (a PROP named width, not `style:width`) must not
    // lock the style property of the same name.
    const node = { codeProps: ['width'] }
    expect(isPropWritableToSource(node, 'width')).toBe(false)
    expect(isStyleWritableToSource(node, 'width')).toBe(true)
  })
})
