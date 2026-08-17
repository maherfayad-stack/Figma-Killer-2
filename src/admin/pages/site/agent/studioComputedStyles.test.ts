/**
 * studio_computed_styles — reads resolved style off a live board frame.
 *
 * The assertions that matter are the ones a screenshot could not answer:
 * that a node's real font-size is reported as a NUMBER, and that a font family
 * is reported per node so an unexpected entry in `fontFamiliesInUse` names a
 * font that failed to load.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { runStudioComputedStyles } from './studioComputedStyles'

const PAGE_ID = 'sign-up'

/** Build the frame shape `findAgentRenderFrame` looks for: data-page-id wrapper > data-breakpoint-id viewport > nodes. */
function mountFrame(nodes: Array<{ id: string; tag?: string; style?: string; text?: string }>): void {
  const wrapper = document.createElement('div')
  wrapper.setAttribute('data-page-id', PAGE_ID)
  const viewport = document.createElement('div')
  viewport.setAttribute('data-breakpoint-id', 'studio')
  wrapper.appendChild(viewport)
  for (const n of nodes) {
    const el = document.createElement(n.tag ?? 'div')
    el.setAttribute('data-node-id', n.id)
    if (n.style) el.setAttribute('style', n.style)
    if (n.text) el.textContent = n.text
    viewport.appendChild(el)
  }
  document.body.appendChild(wrapper)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('runStudioComputedStyles', () => {
  it('errors clearly when the page has no live frame', () => {
    const result = runStudioComputedStyles({ pageId: 'not-mounted' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No live frame')
    // Names the cause the caller can act on rather than just failing.
    expect(result.error).toContain('open in a Studio tab')
  })

  it('reports font-size as a number, not the raw CSS string', () => {
    mountFrame([{ id: 'n1', tag: 'span', style: 'font-size: 14px', text: 'Continue' }])
    const result = runStudioComputedStyles({ pageId: PAGE_ID })
    expect(result.ok).toBe(true)
    const node = (result.data as { nodes: Array<{ nodeId: string; fontSizePx: number; text?: string }> }).nodes[0]
    expect(node?.nodeId).toBe('n1')
    expect(node?.fontSizePx).toBe(14)
    expect(typeof node?.fontSizePx).toBe('number')
    expect(node?.text).toBe('Continue')
  })

  // textOnly is the default because a type mismatch always lives on a node with
  // its own text; a container's concatenated subtree text is noise.
  it('skips nodes without their own text by default, and counts them honestly', () => {
    mountFrame([
      { id: 'wrap', style: 'font-size: 16px' },
      { id: 'label', tag: 'span', style: 'font-size: 14px', text: 'Verify Number' },
    ])
    const result = runStudioComputedStyles({ pageId: PAGE_ID })
    const data = result.data as { nodes: Array<{ nodeId: string }>; skippedWithoutOwnText?: number }
    expect(data.nodes.map((n) => n.nodeId)).toEqual(['label'])
    expect(data.skippedWithoutOwnText).toBe(1)
  })

  it('includes containers when textOnly is false', () => {
    mountFrame([
      { id: 'wrap', style: 'font-size: 16px' },
      { id: 'label', tag: 'span', style: 'font-size: 14px', text: 'Agree' },
    ])
    const result = runStudioComputedStyles({ pageId: PAGE_ID, textOnly: false })
    const data = result.data as { nodes: Array<{ nodeId: string }> }
    expect(data.nodes.map((n) => n.nodeId).sort()).toEqual(['label', 'wrap'])
  })

  // An explicit nodeIds request is honoured verbatim: dropping a requested node
  // for having no text would read as "that node does not exist".
  it('honours an explicit nodeIds request even for a text-free node', () => {
    mountFrame([{ id: 'wrap', style: 'font-size: 16px' }])
    const result = runStudioComputedStyles({ pageId: PAGE_ID, nodeIds: ['wrap'] })
    const data = result.data as { nodes: Array<{ nodeId: string }> }
    expect(data.nodes.map((n) => n.nodeId)).toEqual(['wrap'])
  })

  it('surfaces every font family in use, so one unexpected entry names a font that did not load', () => {
    mountFrame([
      { id: 'a', tag: 'span', style: 'font-size: 14px; font-family: "Open Sans", sans-serif', text: 'one' },
      { id: 'b', tag: 'span', style: 'font-size: 14px; font-family: "Open Sans", sans-serif', text: 'two' },
    ])
    const result = runStudioComputedStyles({ pageId: PAGE_ID })
    const data = result.data as { fontFamiliesInUse: string[] }
    // Deduplicated across nodes — a per-node dump would bury the signal.
    expect(data.fontFamiliesInUse.length).toBe(1)
  })

  it('caps output at limit and says so', () => {
    mountFrame(Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, tag: 'span', style: 'font-size: 14px', text: `t${i}` })))
    const result = runStudioComputedStyles({ pageId: PAGE_ID, limit: 2 })
    const data = result.data as { nodes: unknown[]; truncated: boolean; nodeCount: number }
    expect(data.nodes.length).toBe(2)
    expect(data.nodeCount).toBe(2)
    expect(data.truncated).toBe(true)
  })
})
