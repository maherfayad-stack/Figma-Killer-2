/**
 * Flow connector geometry and routing.
 *
 * The invariant worth guarding is that every number here is in BOARD space and
 * derived only from `BoardFrame` — no DOM, no zoom, no pan. That is what keeps
 * the connectors off the animation-frame path (`STUDIO-PROTOTYPE-PLAN.md` §6),
 * and a test that ever needs a viewport to pass is the signal it has been lost.
 */
import { describe, expect, it } from 'bun:test'
import type { BoardFrame } from '@core/studio-board'
import { codeFlowEdgeId, type CodeFlowEdge } from '@core/studio-prototype'
import { flowConnector } from '../flowGeometry'
import { routeCodeFlow } from '../flowRouting'

function frame(id: string, pageId: string, x: number, y: number): BoardFrame {
  return { id, pageId, x, y, width: 400, height: 300 }
}

function edge(sourcePageId: string, targetPageId: string, sourceNodeId = 'pages/Home.tsx:1:1'): CodeFlowEdge {
  const base = { sourcePageId, targetPageId, sourceNodeId, via: 'href' as const, evidence: 'href="/x"' }
  return { id: codeFlowEdgeId(base), ...base }
}

describe('flowConnector', () => {
  const source = { x: 0, y: 0, w: 400, h: 300 }

  it('leaves the right edge and enters the left edge for frames laid out in a row', () => {
    const connector = flowConnector(source, { x: 600, y: 0, w: 400, h: 300 })!
    expect(connector.tipX).toBe(600)
    expect(connector.tipY).toBe(150)
    expect(connector.tipAngle).toBe(0)
    expect(connector.path.startsWith('M ')).toBe(true)
  })

  it('mirrors when the target is to the LEFT', () => {
    const connector = flowConnector(source, { x: -600, y: 0, w: 400, h: 300 })!
    expect(connector.tipX).toBe(-200)
    expect(connector.tipAngle).toBe(180)
  })

  it('connects bottom to top when the frames are stacked', () => {
    const connector = flowConnector(source, { x: 0, y: 500, w: 400, h: 300 })!
    expect(connector.tipY).toBe(500)
    expect(connector.tipAngle).toBe(90)
  })

  it('sizes the viewport so the curve cannot be clipped by it', () => {
    const connector = flowConnector(source, { x: 600, y: 0, w: 400, h: 300 })!
    // The curve lives inside the control hull; the box is that hull plus slack,
    // so both endpoints sit strictly inside it.
    expect(connector.left).toBeLessThan(400)
    expect(connector.left + connector.width).toBeGreaterThan(600)
    expect(connector.top).toBeLessThan(150)
    expect(connector.top + connector.height).toBeGreaterThan(150)
  })

  it('draws nothing between a frame and itself', () => {
    expect(flowConnector(source, { ...source })).toBeNull()
  })

  it('is pan/zoom invariant — translating BOTH frames translates the connector exactly', () => {
    const a = flowConnector(source, { x: 600, y: 0, w: 400, h: 300 })!
    const b = flowConnector({ ...source, x: 1000, y: 50 }, { x: 1600, y: 50, w: 400, h: 300 })!
    expect(b.tipX - a.tipX).toBe(1000)
    expect(b.tipY - a.tipY).toBe(50)
    expect(b.width).toBe(a.width)
  })
})

describe('routeCodeFlow', () => {
  it('draws one line per frame pair, however many edges run between them', () => {
    const frames = [frame('f1', 'home', 0, 0), frame('f2', 'details', 600, 0)]
    const lines = routeCodeFlow(
      [edge('home', 'details'), edge('home', 'details', 'pages/Home.tsx:9:4')],
      frames,
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]!.details).toHaveLength(2)
    expect(lines[0]!.chip).toBe('2 links')
  })

  it('draws nothing when either end has no frame on this board', () => {
    const frames = [frame('f1', 'home', 0, 0)]
    expect(routeCodeFlow([edge('home', 'details')], frames)).toEqual([])
    expect(routeCodeFlow([edge('checkout', 'home')], frames)).toEqual([])
  })

  it('connects each variant frame to the NEAREST copy of the target page', () => {
    const frames = [
      frame('near', 'details', 600, 0),
      frame('far', 'details', 6000, 0),
      frame('home', 'home', 0, 0),
    ]
    const lines = routeCodeFlow([edge('home', 'details')], frames)
    expect(lines.map((l) => l.key)).toEqual(['code:home->near'])
  })

  it('draws one line per SOURCE variant, so a duplicated frame still shows its flow', () => {
    const frames = [
      frame('home-a', 'home', 0, 0),
      frame('home-b', 'home', 0, 500),
      frame('details', 'details', 600, 0),
    ]
    expect(routeCodeFlow([edge('home', 'details')], frames)).toHaveLength(2)
  })

  it('draws nothing for a page that navigates to itself with one frame on the board', () => {
    expect(routeCodeFlow([edge('home', 'home')], [frame('f1', 'home', 0, 0)])).toEqual([])
  })
})

