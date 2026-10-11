/**
 * dropCandidates - a design-system call site is hosted on a `display: contents`
 * element with no box of its own; it must still be a drop candidate, measured as
 * the union of what it renders, or `nearestFlowIndex` has nothing to place an
 * insert beside and appends it at the end of the column. Boxes are stubbed
 * (happy-dom has no layout).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { collectDropCandidates } from '@core/studio-runtime'

afterEach(() => {
  document.body.innerHTML = ''
})

function box(el: Element, x: number, y: number, width: number, height: number): void {
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + width, bottom: y + height, x, y, width, height, toJSON: () => ({}) }) as DOMRect
}

describe('collectDropCandidates', () => {
  it('measures a box-less host as the union of its children, so an instance is a candidate', () => {
    document.body.innerHTML = `
      <div data-node-id="form" style="display:flex;flex-direction:column">
        <p data-node-id="first"></p>
        <div data-node-id="button" style="display:contents"><button></button></div>
      </div>`
    box(document.body, 0, 0, 400, 400)
    box(document.querySelector('[data-node-id="form"]')!, 0, 0, 400, 200)
    box(document.querySelector('[data-node-id="first"]')!, 0, 0, 400, 20)
    box(document.querySelector('[data-node-id="button"]')!, 0, 0, 0, 0)
    box(document.querySelector('button')!, 0, 40, 223, 48)

    const candidates = collectDropCandidates(document)
    const button = candidates.find((candidate) => candidate.nodeId === 'button')
    expect(button, 'the instance has no drop candidate').toBeDefined()
    expect(button?.rect).toEqual({ x: 0, y: 40, width: 223, height: 48 })
  })

  it('still leaves out a node with neither a box nor a boxed descendant', () => {
    document.body.innerHTML = `<div data-node-id="empty" style="display:contents"></div>`
    box(document.body, 0, 0, 100, 100)
    expect(collectDropCandidates(document)).toEqual([])
  })
})
