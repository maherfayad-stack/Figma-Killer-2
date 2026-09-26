/**
 * P3-C (OD-8) — a `.map` row's STYLE edit is written to the row TEMPLATE, the
 * one piece of JSX that renders every row.
 *
 * OD-8 (settled 2026-09-23): "A style or class edit on a `.map` row goes to the
 * row template". A row has no source location of its own (`…:14:9#2`), so its
 * inline style was disabled in the panel and dropped here. The template
 * (`…:14:9`) is one honest JSX site; writing there changes every row, which the
 * panel says before the edit and `notifyRowTemplateWrites` says after.
 *
 * What stays per-row: a row's own copy (`textOrigin`) writes its own array
 * element. What stays refused: a row's literal ATTRIBUTE (OD-8 is style and
 * class only), and a style on a node with no template at all.
 *
 * The fixture is a restaurant menu and shares nothing with the eSIM corpus.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base/text'
import { loopTemplateNodeId, type Page, type PageNode } from '@core/page-tree'
import { collectNodeDiffEdits } from '../nodeDiffWriteback'
import { resetLoadedValues } from '../loadedValuesBaseline'
import { makeNode, makePage } from '../../../../../__tests__/fixtures'

const TEMPLATE = 'pages/Menu.tsx:14:9'
const ROW_0 = `${TEMPLATE}#0`
const ROW_1 = `${TEMPLATE}#1`

function row(id: string, overrides: Partial<PageNode> = {}): PageNode {
  return makeNode({
    id,
    moduleId: 'base.text',
    props: { text: id.endsWith('#0') ? 'Ramen' : 'Pho', tag: 'li', title: 'Dish' },
    codeProps: ['tag', 'title'],
    textOrigin: { rel: 'pages/Menu.tsx', line: 3, col: id.endsWith('#0') ? 30 : 60 },
    ...overrides,
  })
}

function menu(rows: PageNode[], body: Partial<PageNode> = {}): Page {
  return makePage({
    id: 'menu',
    rootNodeId: 'menu:body',
    nodes: {
      'menu:body': makeNode({ id: 'menu:body', moduleId: 'base.body', children: rows.map((r) => r.id), ...body }),
      ...Object.fromEntries(rows.map((r) => [r.id, r])),
    },
  })
}

beforeEach(() => {
  resetLoadedValues([menu([row(ROW_0), row(ROW_1)])])
})

describe('loopTemplateNodeId', () => {
  it('drops the loop suffix of a row, of a nested row, and keeps a call-site prefix', () => {
    expect(loopTemplateNodeId(ROW_1)).toBe(TEMPLATE)
    expect(loopTemplateNodeId(`${TEMPLATE}#0#3`)).toBe(TEMPLATE)
    expect(loopTemplateNodeId('pages/Menu.tsx:9:3~components/Dish.tsx:4:5#2')).toBe('pages/Menu.tsx:9:3~components/Dish.tsx:4:5')
  })

  it('is null for anything that is not a row', () => {
    expect(loopTemplateNodeId(TEMPLATE)).toBeNull()
    expect(loopTemplateNodeId('menu:body')).toBeNull()
    expect(loopTemplateNodeId('V1StGXR8IZ5jdHi6B')).toBeNull()
    // A row of a call site inside a loop writes the COMPONENT, which is plain.
    expect(loopTemplateNodeId('pages/Menu.tsx:14:9#2~components/Dish.tsx:4:5')).toBeNull()
  })
})

describe('OD-8 — a row style edit writes the template', () => {
  it('an inline style on one row is written to the template, naming every row it restyles', () => {
    const { edits, rowTemplateWrites } = collectNodeDiffEdits(
      [menu([row(ROW_0), row(ROW_1, { inlineStyles: { color: 'red' } })])],
      undefined,
    )
    expect(edits).toEqual([{ kind: 'style', nodeId: TEMPLATE, style: { color: 'red' } }])
    expect(rowTemplateWrites).toEqual([{ editKey: `style|${TEMPLATE}|`, nodeId: ROW_1, templateId: TEMPLATE, rowCount: 2 }])
  })

  it('a row’s own copy still writes its own array element, never the template', () => {
    const { edits, rowTemplateWrites } = collectNodeDiffEdits(
      [menu([row(ROW_0), row(ROW_1, { props: { text: 'Pho ga', tag: 'li', title: 'Dish' } })])],
      undefined,
    )
    expect(edits).toEqual([{ kind: 'literal', nodeId: 'pages/Menu.tsx:3:60', text: 'Pho ga' }])
    expect(rowTemplateWrites).toEqual([])
  })

  it('still refuses a row’s literal ATTRIBUTE — OD-8 is style and class only', () => {
    const { edits } = collectNodeDiffEdits(
      [menu([row(ROW_0), row(ROW_1, { props: { text: 'Pho', tag: 'li', title: 'Soup' } })])],
      undefined,
    )
    expect(edits).toEqual([])
  })

  it('still writes nothing for a style on a node with no template (the synthetic root)', () => {
    resetLoadedValues([menu([row(ROW_0)])])
    const { edits, rowTemplateWrites } = collectNodeDiffEdits([menu([row(ROW_0)], { inlineStyles: { color: 'red' } })], undefined)
    expect(edits).toEqual([])
    expect(rowTemplateWrites).toEqual([])
  })
})
