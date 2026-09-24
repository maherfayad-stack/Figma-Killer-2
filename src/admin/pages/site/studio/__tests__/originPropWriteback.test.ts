/**
 * P3-C (WB-8) — a prop whose value the parser traced to ONE string literal
 * (`resolvedProps[k].origin`) is written at that literal, from every node shape
 * that can carry one.
 *
 * `isPropWritableToSource` already said "writable" for all of these, so the
 * panel offered an ordinary input. Two of them then broke the promise at save:
 *
 * - a `.map` row's prop (`title={dish.title}`, each row its own array element)
 *   reached the location guard and was DROPPED — no edit, no refusal, gone on
 *   reload;
 * - an instance's call-site prop (`<SectionHeading title={heading}/>` inside a
 *   component, resolved through the OUTER call site's literal) was sent as a
 *   `prop` edit at the call site, where `setJsxProp` refuses
 *   `binding-overwrite` — a warning for an edit the editor could have written.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base/text'
import type { Page, PageNode } from '@core/page-tree'
import { collectNodeDiffEdits } from '../nodeDiffWriteback'
import { resetLoadedValues } from '../loadedValuesBaseline'
import { makeNode, makePage } from '../../../../../__tests__/fixtures'

const ROW_ID = 'pages/Menu.tsx:14:9#1'
const INSTANCE_ID = 'pages/Menu.tsx:11:7~components/RecipeCard.tsx:5:7'
const PLAIN_ID = 'pages/Menu.tsx:12:7'

const ROW_ORIGIN = { rel: 'pages/Menu.tsx', line: 5, col: 42 }
const INSTANCE_ORIGIN = { rel: 'pages/Menu.tsx', line: 11, col: 28 }
const DICTIONARY_ORIGIN = { rel: 'copy.ts', line: 1, col: 30 }
const TEXT_ORIGIN = { rel: 'copy.ts', line: 2, col: 12 }

function menu(overrides: { row?: Record<string, unknown>; instance?: Record<string, unknown>; plain?: Record<string, unknown> } = {}): Page {
  const row: PageNode = makeNode({
    id: ROW_ID,
    moduleId: 'base.text',
    props: { text: 'Pho', title: 'Hot bowl', ...overrides.row },
    codeProps: ['text', 'title'],
    resolvedProps: { title: { source: 'dish.title', origin: ROW_ORIGIN } },
  })
  const instance: PageNode = makeNode({
    id: INSTANCE_ID,
    moduleId: 'studio.instance',
    props: {
      componentName: 'SectionHeading',
      source: 'local',
      sourceFile: 'components/SectionHeading.tsx',
      callSiteProps: { title: 'Soups', ...overrides.instance },
    },
    codeProps: ['callSiteProps:title'],
    resolvedProps: { 'callSiteProps:title': { source: 'heading', origin: INSTANCE_ORIGIN } },
  })
  const plain: PageNode = makeNode({
    id: PLAIN_ID,
    moduleId: 'base.text',
    props: { text: 'Cook tonight', title: 'Tonight', ...overrides.plain },
    codeProps: ['title'],
    resolvedProps: { title: { source: 'COPY.hint', origin: DICTIONARY_ORIGIN }, text: { source: 'COPY.cta', origin: TEXT_ORIGIN } },
    textOrigin: TEXT_ORIGIN,
  })
  return makePage({
    id: 'menu',
    rootNodeId: 'menu:body',
    nodes: {
      'menu:body': makeNode({ id: 'menu:body', moduleId: 'base.body', children: [ROW_ID, INSTANCE_ID, PLAIN_ID] }),
      [ROW_ID]: row,
      [INSTANCE_ID]: instance,
      [PLAIN_ID]: plain,
    },
  })
}

const at = (origin: { rel: string; line: number; col: number }) => `${origin.rel}:${origin.line}:${origin.col}`

beforeEach(() => {
  resetLoadedValues([menu()])
})

describe('WB-8 — an origin-backed prop writes at its origin', () => {
  it('sends nothing for an unchanged document', () => {
    expect(collectNodeDiffEdits([menu()], undefined).edits).toEqual([])
  })

  it('a .map row’s prop writes its own array element', () => {
    const { edits } = collectNodeDiffEdits([menu({ row: { title: 'Warm bowl' } })], undefined)
    expect(edits).toEqual([{ kind: 'literal', nodeId: at(ROW_ORIGIN), text: 'Warm bowl' }])
  })

  it('an instance’s call-site prop writes the literal it resolved through, never a prop over the binding', () => {
    const { edits } = collectNodeDiffEdits([menu({ instance: { title: 'Stews' } })], undefined)
    expect(edits).toEqual([{ kind: 'literal', nodeId: at(INSTANCE_ORIGIN), text: 'Stews' }])
  })

  it('a plain node’s dictionary prop still writes the dictionary, and its text is sent once', () => {
    const { edits } = collectNodeDiffEdits([menu({ plain: { title: 'Later', text: 'Cook later' } })], undefined)
    expect(edits).toEqual([
      { kind: 'literal', nodeId: at(TEXT_ORIGIN), text: 'Cook later' },
      { kind: 'literal', nodeId: at(DICTIONARY_ORIGIN), text: 'Later' },
    ])
  })

  it('a row’s prop with NO origin is still not written', () => {
    const page = menu({ row: { text: 'Soup' } })
    expect(collectNodeDiffEdits([page], undefined).edits).toEqual([])
  })
})
