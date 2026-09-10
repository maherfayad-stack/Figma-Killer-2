/**
 * measureCanvasDropCandidates — registry-based iframe document access
 * (`live-05`, STATE.md, the architect's Batch 4 resolution).
 *
 * `canvasDomGeometry.ts`'s own portal-only `portalDocumentForIframe` helper
 * replaced a direct `iframe.contentDocument` reach-in — this proves the
 * observable behavior change: an unregistered iframe (or an unregistered
 * one whose registration was since removed) falls back to `viewport` as the
 * query scope, exactly like a `null`/`undefined` iframe argument always has.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { measureCanvasDropCandidates } from '@site/canvas/canvasDomGeometry'
import {
  registerFrameAdapter,
  unregisterFrameAdapter,
} from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'

let adapters: PortalFrameAdapter[] = []

afterEach(() => {
  document.body.innerHTML = ''
  for (const adapter of adapters) adapter.dispose()
  adapters = []
})

function stubRect(el: HTMLElement): void {
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20,
    toJSON() { return this },
  })
}

function makeTree(nodeId: string): NodeTree<PageNode> {
  const node = { id: nodeId, moduleId: 'base.div', children: [] } as unknown as PageNode
  return { rootNodeId: nodeId, nodes: { [nodeId]: node } }
}

describe('measureCanvasDropCandidates — registry-based iframe access', () => {
  it('finds candidates inside a REGISTERED iframe document', () => {
    const viewport = document.createElement('div')
    document.body.appendChild(viewport)

    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const frameDoc = iframe.contentDocument!
    const target = frameDoc.createElement('div')
    target.setAttribute('data-node-id', 'n1')
    frameDoc.body.appendChild(target)
    stubRect(target)

    const adapter = new PortalFrameAdapter(frameDoc)
    adapters.push(adapter)
    registerFrameAdapter(iframe, adapter)

    const candidates = measureCanvasDropCandidates(viewport, makeTree('n1'), iframe)
    expect(candidates.map((c) => c.nodeId)).toEqual(['n1'])
  })

  it('finds nothing for an UNREGISTERED iframe — falls back to the viewport, never the raw contentDocument', () => {
    const viewport = document.createElement('div')
    document.body.appendChild(viewport)

    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const frameDoc = iframe.contentDocument!
    const target = frameDoc.createElement('div')
    target.setAttribute('data-node-id', 'n1')
    frameDoc.body.appendChild(target)
    stubRect(target)
    // Deliberately NOT registered — e.g. a plugin/preview iframe, or a
    // canvas frame whose adapter hasn't been constructed yet.

    const candidates = measureCanvasDropCandidates(viewport, makeTree('n1'), iframe)
    expect(candidates).toEqual([])
  })

  it('stops finding candidates once the frame is unregistered', () => {
    const viewport = document.createElement('div')
    document.body.appendChild(viewport)

    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const frameDoc = iframe.contentDocument!
    const target = frameDoc.createElement('div')
    target.setAttribute('data-node-id', 'n1')
    frameDoc.body.appendChild(target)
    stubRect(target)

    const adapter = new PortalFrameAdapter(frameDoc)
    adapters.push(adapter)
    registerFrameAdapter(iframe, adapter)
    expect(measureCanvasDropCandidates(viewport, makeTree('n1'), iframe)).toHaveLength(1)

    unregisterFrameAdapter(iframe)
    expect(measureCanvasDropCandidates(viewport, makeTree('n1'), iframe)).toHaveLength(0)
  })
})
