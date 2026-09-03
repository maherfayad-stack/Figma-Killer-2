/**
 * When drag handles are offered, and — the point of the module — when they
 * are not.
 *
 * The regression these guard is a resize that LOOKS like it worked: the
 * element tracks the pointer for the whole gesture, the store takes the
 * change, and then `fsCodemodAdapter.saveSite` drops it because the node's
 * module does not own its own `style=""`. The user sees the element snap back
 * on release with no explanation, which is the one outcome Studio's §2
 * invariant rules out.
 */
import { describe, it, expect } from 'bun:test'
import { canOfferResize } from '@site/canvas/resizeOffer'

const sizeable = { moduleId: 'base.container', hasOwnElement: true, display: 'block' }

describe('canOfferResize', () => {
  it('offers a resize on a base.* element with a box of its own', () => {
    expect(canOfferResize(sizeable)).toBe(true)
    expect(canOfferResize({ ...sizeable, display: 'flex' })).toBe(true)
    expect(canOfferResize({ ...sizeable, moduleId: 'base.text', display: 'inline-block' })).toBe(true)
  })

  it('offers a resize on an alm.* design-system call site', () => {
    // `<Button style={{ width: '170px' }} />` reaches the rendered button,
    // because every component in that package spreads its rest props onto its
    // root. `display` here is the PRESENTED element's — the button — not the
    // `display: contents` host that carries the node id.
    expect(canOfferResize({ ...sizeable, moduleId: 'alm.Button', display: 'inline-block' })).toBe(true)
  })

  it('refuses an arbitrary package component — nothing says it forwards a style', () => {
    expect(canOfferResize({ ...sizeable, moduleId: 'pkg.acme-card' })).toBe(false)
  })

  it('refuses a component call site, which renders no box of its own', () => {
    // A `studio.instance` is a Fragment; the box under the handles belongs to
    // a DIFFERENT node, so a drag here sizes something the user did not pick.
    expect(canOfferResize({ ...sizeable, moduleId: 'studio.instance' })).toBe(false)
    expect(canOfferResize({ ...sizeable, hasOwnElement: false, display: '' })).toBe(false)
  })

  it('refuses a display CSS ignores a size on', () => {
    for (const display of ['inline', 'contents', 'none']) {
      expect(canOfferResize({ ...sizeable, display })).toBe(false)
    }
  })

  it('refuses when the node cannot be resolved at all', () => {
    // No node means no way to know whether the write lands. Guessing "yes" is
    // exactly how the snap-back shipped.
    expect(canOfferResize({ ...sizeable, moduleId: null })).toBe(false)
  })
})
