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

  it('is writable for alm.* design-system call sites, which forward rest props to their root', () => {
    // `<Button style={{ width: '170px' }} />` is one honest target: one source
    // location, one rendered element. Every component in that package spreads
    // its rest props onto its root, which is the same bet
    // `src/modules/alm/register.tsx` already makes when it passes the node's
    // inline styles to the component for the CANVAS.
    expect(canWriteInlineStyleForModule('alm.Button')).toBe(true)
    expect(canWriteInlineStyleForModule('alm.card')).toBe(true)
  })

  it('is unwritable for pkg.* and studio.instance modules', () => {
    // An arbitrary third-party package gives no basis for believing it
    // forwards anything; a component call site renders no element at all.
    expect(canWriteInlineStyleForModule('pkg.acme-button')).toBe(false)
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
