/**
 * `inspectFrameDocument` — the ONE reader both the headless capture page and
 * the live editor canvas run.
 *
 * Tested against a real document rather than a stub, because every interesting
 * behaviour here is a DOM behaviour: which elements `[data-node-id]` selects,
 * what counts as a node's OWN text (as opposed to its subtree's), and — the
 * one that matters most — that a node explicitly asked for by id is reported
 * even when it has no text at all, while the same node is skipped in a
 * `textOnly` sweep.
 *
 * Geometry assertions are deliberately restricted to what a non-layouting DOM
 * can honestly answer (which elements come back, in what order, with which
 * parent and which sibling relationships). The pixel arithmetic that needs a
 * real layout engine is exercised by the headless driver's own suite, where a
 * browser is the thing under test.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { inspectFrameDocument, inspectFrameDocumentJson } from './frameInspector'
import type { AgentComputedStylesResult, AgentMeasureResult } from './frameInspectWire'

function mountFrame(html: string): { doc: Document; view: Window } {
  document.body.innerHTML = html
  const view = document.defaultView
  if (!view) throw new Error('no default view')
  return { doc: document, view }
}

function computedStyles(
  doc: Document,
  view: Window,
  request: Omit<Parameters<typeof inspectFrameDocument>[2] & { kind: 'computedStyles' }, 'kind'>,
): AgentComputedStylesResult {
  const response = inspectFrameDocument(doc, view, { kind: 'computedStyles', ...request })
  if (!response.ok) throw new Error(response.error)
  if (response.result.kind !== 'computedStyles') throw new Error('wrong result kind')
  return response.result
}

function measure(
  doc: Document,
  view: Window,
  request: { pageId: string; nodeIds?: string[]; selector?: string; limit?: number },
): AgentMeasureResult {
  const response = inspectFrameDocument(doc, view, { kind: 'measure', ...request })
  if (!response.ok) throw new Error(response.error)
  if (response.result.kind !== 'measure') throw new Error('wrong result kind')
  return response.result
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('computedStyles', () => {
  it('reports one row per authored node with its own text, and nothing else', () => {
    const { doc, view } = mountFrame(`
      <div data-node-id="root">
        <h1 data-node-id="title" style="font-size: 26px; font-weight: 600;">Checkout</h1>
        <p data-node-id="body" style="font-size: 14px;">Review your order</p>
      </div>
    `)
    const result = computedStyles(doc, view, { pageId: 'checkout' })
    expect(result.nodes.map((n) => n.nodeId).sort()).toEqual(['body', 'title'])
    // The wrapper has no text of its OWN — a container's concatenated subtree
    // text is noise, and counting it as text would report every ancestor.
    expect(result.skippedWithoutOwnText).toBe(1)
    expect(result.nodeCount).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('reports a node asked for BY ID even when it has no text — the caller named it', () => {
    const { doc, view } = mountFrame(`
      <div data-node-id="card"><span data-node-id="label">Total</span></div>
    `)
    const result = computedStyles(doc, view, { pageId: 'p', nodeIds: ['card'] })
    expect(result.nodes.map((n) => n.nodeId)).toEqual(['card'])
    // An explicit request is not a sweep, so the skipped counter is absent
    // rather than 0 — "we filtered nothing out" and "we filtered out none" are
    // different answers.
    expect(result.skippedWithoutOwnText).toBeUndefined()
  })

  it('includes containers when textOnly is false', () => {
    const { doc, view } = mountFrame(`
      <div data-node-id="card"><span data-node-id="label">Total</span></div>
    `)
    const result = computedStyles(doc, view, { pageId: 'p', textOnly: false })
    expect(result.nodes.map((n) => n.nodeId).sort()).toEqual(['card', 'label'])
  })

  it('truncates at the limit and says so', () => {
    const { doc, view } = mountFrame(
      Array.from({ length: 5 }, (_, i) => `<p data-node-id="n${i}">row ${i}</p>`).join(''),
    )
    const result = computedStyles(doc, view, { pageId: 'p', limit: 2 })
    expect(result.nodes).toHaveLength(2)
    expect(result.nodeCount).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('collapses a node\'s own text and drops its descendants\' text', () => {
    const { doc, view } = mountFrame(`
      <p data-node-id="mixed">  Hello\n  <em data-node-id="inner">world</em>  </p>
    `)
    const result = computedStyles(doc, view, { pageId: 'p', nodeIds: ['mixed'] })
    expect(result.nodes[0]!.text).toBe('Hello')
  })

  it('reports every font family in use, deduplicated and sorted', () => {
    const { doc, view } = mountFrame(`
      <p data-node-id="a" style="font-family: Alpha;">a</p>
      <p data-node-id="b" style="font-family: Zulu;">b</p>
      <p data-node-id="c" style="font-family: Alpha;">c</p>
    `)
    const result = computedStyles(doc, view, { pageId: 'p' })
    expect(result.fontFamiliesInUse).toEqual([...result.fontFamiliesInUse].sort())
    expect(new Set(result.fontFamiliesInUse).size).toBe(result.fontFamiliesInUse.length)
  })
})

describe('measure', () => {
  it('measures every authored node when neither nodeIds nor selector is given', () => {
    const { doc, view } = mountFrame(`
      <div data-node-id="list">
        <div data-node-id="a">A</div>
        <div data-node-id="b">B</div>
      </div>
    `)
    const result = measure(doc, view, { pageId: 'p' })
    expect(result.elements.map((e) => e.nodeId)).toEqual(['list', 'a', 'b'])
    expect(result.matched).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it('reports a requested node id that renders nothing as unmatched, never as an empty result', () => {
    const { doc, view } = mountFrame(`<div data-node-id="a">A</div>`)
    const result = measure(doc, view, { pageId: 'p', nodeIds: ['a', 'ghost'] })
    expect(result.elements.map((e) => e.nodeId)).toEqual(['a'])
    expect(result.unmatched).toEqual(['ghost'])
  })

  it('unions nodeIds with a selector rather than concatenating two lists', () => {
    const { doc, view } = mountFrame(`
      <div data-node-id="a" class="card">A</div>
      <div data-node-id="b" class="card">B</div>
    `)
    const result = measure(doc, view, { pageId: 'p', nodeIds: ['a'], selector: '.card' })
    // "a" matches both filters and is reported once, in document order.
    expect(result.elements.map((e) => e.nodeId)).toEqual(['a', 'b'])
  })

  it('refuses an invalid selector with a readable sentence instead of throwing', () => {
    const { doc, view } = mountFrame(`<div data-node-id="a">A</div>`)
    const response = inspectFrameDocument(doc, view, { kind: 'measure', pageId: 'p', selector: ':::' })
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('expected a refusal')
    expect(response.error).toContain('not a valid CSS selector')
  })

  it('carries the parent\'s layout alongside each element, so a gap can be read against the rule that made it', () => {
    const { doc, view } = mountFrame(`
      <div data-node-id="row" style="display: flex; flex-direction: row; gap: 16px;">
        <div data-node-id="a">A</div>
        <div data-node-id="b">B</div>
      </div>
    `)
    const result = measure(doc, view, { pageId: 'p', nodeIds: ['b'] })
    const b = result.elements[0]!
    expect(b.parent?.nodeId).toBe('row')
    expect(b.parent?.tag).toBe('div')
    expect(b.siblingAxis).toBe('inline')
  })

  it('defaults to the block axis for a non-row parent', () => {
    const { doc, view } = mountFrame(`
      <div data-node-id="col"><div data-node-id="a">A</div><div data-node-id="b">B</div></div>
    `)
    const result = measure(doc, view, { pageId: 'p', nodeIds: ['b'] })
    expect(result.elements[0]!.siblingAxis).toBe('block')
  })

  it('truncates at the limit and reports the honest matched count', () => {
    const { doc, view } = mountFrame(
      Array.from({ length: 5 }, (_, i) => `<div data-node-id="n${i}">${i}</div>`).join(''),
    )
    const result = measure(doc, view, { pageId: 'p', limit: 2 })
    expect(result.elements).toHaveLength(2)
    expect(result.matched).toBe(5)
    expect(result.truncated).toBe(true)
  })
})

describe('inspectFrameDocumentJson — the string boundary the headless driver calls', () => {
  it('validates the request and never throws on malformed JSON', () => {
    const raw = inspectFrameDocumentJson(() => null, 'not json at all')
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      error: expect.stringContaining('not valid JSON') as unknown as string,
    })
  })

  it('refuses a request that fails schema validation', () => {
    const raw = inspectFrameDocumentJson(() => null, JSON.stringify({ kind: 'nonsense', pageId: 'p' }))
    const parsed = JSON.parse(raw) as { ok: boolean; error: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('failed validation')
  })

  it('names the page when no settled frame document exists for it', () => {
    const raw = inspectFrameDocumentJson(() => null, JSON.stringify({ kind: 'computedStyles', pageId: 'checkout' }))
    const parsed = JSON.parse(raw) as { ok: boolean; error: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('checkout')
    expect(parsed.error).toContain('settled')
  })

  it('answers a valid request against the resolved document', () => {
    const { doc, view } = mountFrame(`<p data-node-id="title">Checkout</p>`)
    const raw = inspectFrameDocumentJson(
      (pageId) => (pageId === 'checkout' ? { doc, view } : null),
      JSON.stringify({ kind: 'computedStyles', pageId: 'checkout' }),
    )
    const parsed = JSON.parse(raw) as { ok: boolean; result: AgentComputedStylesResult }
    expect(parsed.ok).toBe(true)
    expect(parsed.result.nodes.map((n) => n.nodeId)).toEqual(['title'])
  })
})
