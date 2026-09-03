/**
 * Which element a node is SEEN as, when the node id is on a box-less host.
 *
 * `src/modules/alm/register.tsx` puts the editor's `data-node-id` and event
 * handlers on a `display: contents` div and renders the design-system
 * component inside it — deliberately, so the wrapper cannot disturb the
 * component's layout. That host is the right thing to select and the wrong
 * thing to size, and reading ITS display is how every design-system component
 * ends up refused as unsizeable.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { presentedElementForNode } from '@site/canvas/canvasNodeLookup'

function mount(html: string): Document {
  document.body.innerHTML = html
  return document
}

beforeEach(() => { document.body.innerHTML = '' })

describe('presentedElementForNode', () => {
  it('returns the node\'s own element when it renders a real box', () => {
    const doc = mount('<div data-node-id="a:1:1" style="display:block"><span>x</span></div>')
    expect(presentedElementForNode(doc, 'a:1:1')?.getAttribute('data-node-id')).toBe('a:1:1')
  })

  it('descends through a display:contents host to the element that has the box', () => {
    const doc = mount(
      '<div data-node-id="a:1:1" style="display:contents"><button class="btn">Go</button></div>',
    )
    expect(presentedElementForNode(doc, 'a:1:1')?.className).toBe('btn')
  })

  it('descends through more than one transparent wrapper', () => {
    const doc = mount(
      '<div data-node-id="a:1:1" style="display:contents">' +
        '<div style="display:contents"><button class="btn">Go</button></div>' +
      '</div>',
    )
    expect(presentedElementForNode(doc, 'a:1:1')?.className).toBe('btn')
  })

  it('stops at a child that is a node of its OWN', () => {
    // That box belongs to a different node; sizing it here would write the
    // declaration to the wrong source location.
    const doc = mount(
      '<div data-node-id="a:1:1" style="display:contents">' +
        '<div data-node-id="a:2:2" class="child"></div>' +
      '</div>',
    )
    expect(presentedElementForNode(doc, 'a:1:1')?.getAttribute('data-node-id')).toBe('a:1:1')
  })

  it('stops when there is no single element to mean', () => {
    const doc = mount(
      '<div data-node-id="a:1:1" style="display:contents"><i class="one"></i><i class="two"></i></div>',
    )
    expect(presentedElementForNode(doc, 'a:1:1')?.getAttribute('data-node-id')).toBe('a:1:1')
  })

  it('returns null for a node that is not in the document', () => {
    const doc = mount('<div data-node-id="a:1:1"></div>')
    expect(presentedElementForNode(doc, 'nope:9:9')).toBeNull()
  })
})
