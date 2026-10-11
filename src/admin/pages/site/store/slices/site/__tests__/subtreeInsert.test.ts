/**
 * P5-A — `insertJsxSubtreeIntoPage`, the commit behind an SVG pasted from the
 * OS clipboard: the whole converted `<svg>` is ONE `insert` edit whose
 * `children` carry every part, written into the page it was NAMED (which it
 * activates), beside the anchor the index resolves to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import type { SlotJsxNode } from '@site/studio/studioSaveRequests'
import { makeNode, makePage, makeSite } from '../../../../../../../__tests__/fixtures'
import '@modules/base/index'

const HOME_ROOT = 'home:body'
const HOME_MAIN = 'pages/Home.tsx:4:5'
const ABOUT_ROOT = 'about:body'
const ABOUT_MAIN = 'pages/About.tsx:4:5'
const ABOUT_H1 = 'pages/About.tsx:5:7'

const realFetch = globalThis.fetch
let posted: { edits: Record<string, unknown>[] }[] = []

const ICON: SlotJsxNode = {
  name: 'svg',
  props: { viewBox: '0 0 24 24', fill: 'none' },
  children: [
    { name: 'path', props: { d: 'M4 12h16', stroke: 'currentColor' } },
    { name: 'g', children: [{ name: 'circle', props: { cx: '12', cy: '12', r: '3' } }] },
  ],
}

beforeEach(() => {
  resetStructuralCommitQueue()
  posted = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/admin/api/studio/save')) {
      posted.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(
        JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({
          id: 'home',
          rootNodeId: HOME_ROOT,
          nodes: {
            [HOME_ROOT]: makeNode({ id: HOME_ROOT, moduleId: 'base.container', children: [HOME_MAIN] }),
            [HOME_MAIN]: makeNode({ id: HOME_MAIN, moduleId: 'base.container', parentId: HOME_ROOT }),
          },
        }),
        makePage({
          id: 'about',
          slug: 'about',
          rootNodeId: ABOUT_ROOT,
          nodes: {
            [ABOUT_ROOT]: makeNode({ id: ABOUT_ROOT, moduleId: 'base.container', children: [ABOUT_MAIN] }),
            [ABOUT_MAIN]: makeNode({ id: ABOUT_MAIN, moduleId: 'base.container', parentId: ABOUT_ROOT, children: [ABOUT_H1] }),
            [ABOUT_H1]: makeNode({ id: ABOUT_H1, moduleId: 'base.text', parentId: ABOUT_MAIN }),
          },
        }),
      ],
    }),
  )
  useEditorStore.setState({ activePageId: 'home', structuralRefusalDialog: null } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  globalThis.fetch = realFetch
  resetStructuralCommitQueue()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('insertJsxSubtreeIntoPage — a pasted SVG is one write', () => {
  it('writes ONE insert carrying the whole subtree, into the page it was named', async () => {
    useEditorStore.getState().insertJsxSubtreeIntoPage({ pageId: 'about', parentId: ABOUT_MAIN, index: 0, node: ICON, undoLabel: 'Paste SVG' })
    expect(useEditorStore.getState().activePageId).toBe('about')
    await settle()

    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toHaveLength(1)
    const edit = posted[0]!.edits[0]!
    expect(edit).toMatchObject({
      kind: 'insert',
      nodeId: ABOUT_MAIN,
      anchorNodeId: ABOUT_H1,
      position: 'before',
      name: 'svg',
      props: { viewBox: '0 0 24 24', fill: 'none' },
    })
    expect(edit.children).toEqual(ICON.children)
  })
})
