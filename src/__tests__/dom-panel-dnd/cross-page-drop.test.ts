/**
 * A Layers-panel drop onto a row of ANOTHER page's tree is a transplant, asked
 * of the same resolver the canvas uses for a cross-frame drag — so the panel
 * and the board cannot disagree about where it lands or whether it may.
 */
import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import { resolveDomTransplantDrop } from '@site/panels/DomPanel/domPanelDnd'

function node(id: string, moduleId: string, children: string[] = []): PageNode {
  return { id, moduleId, props: {}, breakpointOverrides: {}, children, locked: false }
}

function page(id: string, nodes: Record<string, PageNode>): Page {
  reindexNodeParents(nodes)
  return { id, slug: id, title: id, rootNodeId: `${id}:body`, nodes }
}

const canHaveChildren = (moduleId: string) => moduleId === 'base.body' || moduleId === 'base.container'

const origin = page('home', {
  'home:body': node('home:body', 'base.body', ['pages/Home.tsx:5:7', 'pages/Home.tsx:6:7']),
  'pages/Home.tsx:5:7': node('pages/Home.tsx:5:7', 'base.text'),
  'pages/Home.tsx:6:7': node('pages/Home.tsx:6:7', 'base.text'),
})
const destination = page('about', {
  'about:body': node('about:body', 'base.body', ['pages/About.tsx:5:5']),
  'pages/About.tsx:5:5': node('pages/About.tsx:5:5', 'base.container', ['pages/About.tsx:6:7']),
  'pages/About.tsx:6:7': node('pages/About.tsx:6:7', 'base.text'),
})

describe('resolveDomTransplantDrop', () => {
  it('names the destination page and a position in ITS tree', () => {
    const { target, refusal } = resolveDomTransplantDrop({
      originPage: origin,
      destinationPage: destination,
      draggedId: 'pages/Home.tsx:5:7',
      draggedIds: ['pages/Home.tsx:5:7'],
      overId: 'pages/About.tsx:5:5',
      zone: 'inside',
      canHaveChildren,
    })
    expect(refusal).toBeNull()
    expect(target).toMatchObject({
      foreignPageId: 'about',
      parentId: 'pages/About.tsx:5:5',
      position: 'inside',
      draggedIds: ['pages/Home.tsx:5:7'],
    })
  })

  it('returns the store gate\'s sentence for a refused drop, alongside the position', () => {
    const { target, refusal } = resolveDomTransplantDrop({
      originPage: origin,
      destinationPage: destination,
      draggedId: 'pages/Home.tsx:5:7',
      draggedIds: ['pages/Home.tsx:5:7', 'pages/Home.tsx:6:7'],
      overId: 'pages/About.tsx:5:5',
      zone: 'inside',
      canHaveChildren,
    })
    expect(target?.foreignPageId).toBe('about')
    expect(refusal?.message).toContain('one by one')
  })

  it('has no target over a row that cannot hold the drop', () => {
    const { target } = resolveDomTransplantDrop({
      originPage: origin,
      destinationPage: destination,
      draggedId: 'pages/Home.tsx:5:7',
      draggedIds: ['pages/Home.tsx:5:7'],
      overId: 'missing',
      zone: 'inside',
      canHaveChildren,
    })
    expect(target).toBeNull()
  })
})
